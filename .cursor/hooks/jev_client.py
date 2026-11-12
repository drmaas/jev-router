#!/usr/bin/env python3
"""Shared Jev HTTP client. Stdlib only (urllib), no third-party dependencies.

Reads TYPESAFE_API_KEY (and optionally TYPESAFE_MODEL / TYPESAFE_ENDPOINT)
from the environment. JEV_PROVIDER=nace selects Nace instead (NACE_API_KEY,
NACE_BASE_URL, NACE_MODEL; see nace.json). Every function fails open: on
missing key, timeout, or HTTP error it returns None instead of raising, so
hooks never block the agent when Jev is unavailable.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_ENDPOINT = "https://api.typesafe.ai"
DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai"
DEFAULT_MODEL = "jev-latest"
DEFAULT_OPENROUTER_MODEL = "typesafe/jev-1.13"
TIMEOUT_S = 12

PROVIDERS = ("typesafe", "openrouter", "nace")


_logged = set()


def _log(message):
    print("[jev-router] " + message, file=sys.stderr)


def _log_once(message):
    """A hook makes several calls with one configuration; say a configuration problem once."""
    if message not in _logged:
        _logged.add(message)
        _log(message)


def _no_key(provider, problem=None):
    """A configuration that sends nothing. `problem` is what stderr says; None stays silent."""
    return {"provider": provider, "api_key": "", "url": "", "model": "", "nace": None, "problem": problem}


def nace_url_problem(url):
    """Nace carries the key, so it goes only over https, or http to this machine.
    None when the URL is fine, else why not."""
    try:
        u = urllib.parse.urlsplit(url)
        host = u.hostname or ""
    except ValueError:
        return "not a valid URL"
    if u.username or u.password:
        return "the URL contains credentials"
    if u.scheme == "https":
        return None if host else "not a valid URL"
    if u.scheme != "http":
        return "the scheme must be https"
    if host in ("localhost", "127.0.0.1", "::1"):
        return None
    return "plain http is only allowed to localhost, 127.0.0.1 or ::1"


def _host_of(url):
    """The host a refusal line names, or "that URL" when the URL has none or cannot be parsed."""
    try:
        return urllib.parse.urlsplit(url).hostname or "that URL"
    except ValueError:
        return "that URL"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def load_nace():
    """The shared Nace descriptor, read only when Nace is chosen so a copy of the hooks
    without nace.json still works for the other providers."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "nace.json"), encoding="utf-8") as f:
        return json.load(f)


def _nace_config():
    try:
        nace = load_nace()
    except (OSError, ValueError) as e:
        return _no_key("nace", "nace: cannot read nace.json (%s)" % type(e).__name__)
    base = (os.environ.get(nace["baseUrlEnv"]) or nace["baseUrl"]).rstrip("/")
    api_key = os.environ.get(nace["keyEnv"], "")
    return {
        "provider": "nace",
        "api_key": api_key,
        "url": base + nace["path"],
        "model": os.environ.get(nace["modelEnv"]) or nace["defaultModel"],
        "nace": nace,
        "problem": None if api_key else "No API key set (%s)" % nace["keyEnv"],
    }


def _keyed_config(cfg):
    """Upstream is silent when no key is set. The one hint added: a Nace key sits in the
    environment, but Nace is chosen only with JEV_PROVIDER=nace."""
    if not cfg["api_key"] and os.environ.get("NACE_API_KEY"):
        cfg["problem"] = (
            "No API key set (TYPESAFE_API_KEY or OPENROUTER_API_KEY); NACE_API_KEY is set, but Nace needs JEV_PROVIDER=nace"
        )
    return cfg


def config():
    """JEV_PROVIDER picks the provider explicitly (typesafe, openrouter or nace).
    Without it, auto-detect: TYPESAFE_API_KEY wins, else OPENROUTER_API_KEY.
    With neither key set, defaults to typesafe (fail open downstream).
    Nace is never auto-detected. An unknown JEV_PROVIDER yields a config with no
    key, so nothing is sent anywhere. `problem` is the reason a config has no key."""
    raw = os.environ.get("JEV_PROVIDER", "")
    chosen = raw.strip().lower()
    if chosen and chosen not in PROVIDERS:
        return _no_key(chosen, 'unknown JEV_PROVIDER (valid values: %s)' % ", ".join(PROVIDERS))
    if chosen == "nace":
        return _nace_config()
    if chosen == "typesafe" or (
        not chosen and (os.environ.get("TYPESAFE_API_KEY") or not os.environ.get("OPENROUTER_API_KEY"))
    ):
        base = os.environ.get("TYPESAFE_ENDPOINT", DEFAULT_ENDPOINT).rstrip("/")
        return _keyed_config(
            {
                "provider": "typesafe",
                "api_key": os.environ.get("TYPESAFE_API_KEY", ""),
                "url": base + "/v1/systemone",
                "model": os.environ.get("TYPESAFE_MODEL", DEFAULT_MODEL),
            }
        )
    base = os.environ.get("TYPESAFE_ENDPOINT", DEFAULT_OPENROUTER_ENDPOINT).rstrip("/")
    path = "" if base.endswith("/api/alpha/decisions") else "/api/alpha/decisions"
    return _keyed_config(
        {
            "provider": "openrouter",
            "api_key": os.environ.get("OPENROUTER_API_KEY", ""),
            "url": base + path,
            "model": os.environ.get("TYPESAFE_MODEL", DEFAULT_OPENROUTER_MODEL),
        }
    )


def _report_nace_failure(e):
    """One stderr line per failed Nace call: status, error type and request id, never the message."""
    error_type = "unknown"
    request_id = e.headers.get("x-request-id") or "none"
    try:
        body = json.loads(e.read().decode("utf-8"))
        error_type = (body.get("error") or {}).get("type") or error_type
        request_id = body.get("request_id") or request_id
    except Exception:
        pass
    _log("nace request failed: %s %s request_id=%s" % (e.code, error_type, request_id))


def system_one(state, questions, timeout=TIMEOUT_S, model=None):
    """POST a decision request. Returns the parsed JSON body, or None on failure."""
    cfg = config()
    is_nace = cfg["provider"] == "nace"
    if not cfg["api_key"]:
        if cfg.get("problem"):
            _log_once(cfg["problem"] + "; Jev calls will be skipped (fail open).")
        return None
    refusal = nace_url_problem(cfg["url"]) if is_nace else None
    if refusal:
        _log("nace: refusing to send the key to %s: %s" % (_host_of(cfg["url"]), refusal))
        return None
    body = json.dumps(
        {
            "state": state,
            "questions": questions,
            "model": model or cfg["model"],
        }
    ).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg["api_key"],
    }
    if is_nace:
        headers[cfg["nace"]["attributionHeader"]] = cfg["nace"]["clients"]["cursor"] + "/" + cfg["nace"]["clientVersion"]
    req = urllib.request.Request(cfg["url"], data=body, headers=headers, method="POST")
    # urllib forwards Authorization across a redirect; Nace never redirects, so refuse one.
    open_url = urllib.request.build_opener(_NoRedirect).open if is_nace else urllib.request.urlopen
    try:
        with open_url(req, timeout=timeout) as res:
            if res.status != 200:
                return None
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if is_nace:
            _report_nace_failure(e)
        return None
    except Exception as e:
        if is_nace:
            _log("nace request failed: " + type(e).__name__)
        return None


def gate_questions():
    """The three request-gating Nouls from the skill_suggestion cookbook."""
    return {
        "gate::acts_on_user_system": {
            "type": "noul",
            "instructions": "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
        },
        "gate::would_follow_documented_procedure": {
            "type": "noul",
            "instructions": "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
        },
        "gate::prose_suffices": {
            "type": "noul",
            "instructions": "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
        },
    }


def gate_mean(answers):
    vals = []
    for key, ans in (answers or {}).items():
        if not key.startswith("gate::"):
            continue
        v = float((ans or {}).get("noul", 0.5))
        if key == "gate::prose_suffices":
            v = 1.0 - v
        vals.append(v)
    if not vals:
        return 0.5
    return sum(vals) / len(vals)
