#!/usr/bin/env python3
"""Shared Jev HTTP client. Stdlib only (urllib), no third-party dependencies.

Reads TYPESAFE_API_KEY (and optionally TYPESAFE_MODEL / TYPESAFE_ENDPOINT)
from the environment. Every function fails open: on missing key, timeout, or
HTTP error it returns None instead of raising, so hooks never block the agent
when Jev is unavailable.
"""

import json
import os
import urllib.request

DEFAULT_ENDPOINT = "https://api.typesafe.ai"
DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai"
DEFAULT_MODEL = "jev-latest"
DEFAULT_OPENROUTER_MODEL = "typesafe/jev-1.13"
TIMEOUT_S = 12


def config():
    """Provider auto-detect: TYPESAFE_API_KEY wins, else OPENROUTER_API_KEY.
    With neither key set, defaults to typesafe (fail open downstream)."""
    if os.environ.get("TYPESAFE_API_KEY") or not os.environ.get("OPENROUTER_API_KEY"):
        base = os.environ.get("TYPESAFE_ENDPOINT", DEFAULT_ENDPOINT).rstrip("/")
        return {
            "provider": "typesafe",
            "api_key": os.environ.get("TYPESAFE_API_KEY", ""),
            "url": base + "/v1/systemone",
            "model": os.environ.get("TYPESAFE_MODEL", DEFAULT_MODEL),
        }
    base = os.environ.get("TYPESAFE_ENDPOINT", DEFAULT_OPENROUTER_ENDPOINT).rstrip("/")
    path = "" if base.endswith("/api/alpha/decisions") else "/api/alpha/decisions"
    return {
        "provider": "openrouter",
        "api_key": os.environ.get("OPENROUTER_API_KEY", ""),
        "url": base + path,
        "model": os.environ.get("TYPESAFE_MODEL", DEFAULT_OPENROUTER_MODEL),
    }


def system_one(state, questions, timeout=TIMEOUT_S, model=None):
    """POST a decision request. Returns the parsed JSON body, or None on failure."""
    cfg = config()
    if not cfg["api_key"]:
        return None
    body = json.dumps(
        {
            "state": state,
            "questions": questions,
            "model": model or cfg["model"],
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        cfg["url"],
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + cfg["api_key"],
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            if res.status != 200:
                return None
            return json.loads(res.read().decode("utf-8"))
    except Exception:
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
