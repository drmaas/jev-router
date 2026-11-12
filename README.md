# jev-router

System One routing for coding agents. Jev decides, LLM generates. (With the opt-in
[Nace backend](#nace-backend), a Drex model decides instead of Jev.)

- **OpenCode v2 plugin** (`plugins/jev-router/`): turn steering via `session.hook("context")`,
  tool-call steering via `tool.hook("execute.before")` (redirect), clarify-vs-act
  + permission gating via `permission.hook("evaluate")`, failure advisor via
  `tool.hook("execute.after")`, subagent routing, code review
  (`reviewTrigger: stop|edits|both`), on-demand decisions via a `jev_ask` tool.
- **Cursor hooks** (`.cursor/`): `beforeShellExecution` policy gate + `stop` verifier, stdlib-only Python.
- **Skill** (`skills/jev-router/SKILL.md`): teaches an agent when to reach for Jev vs the LLM.

Upstream API docs: https://docs.typesafe.ai/llms.txt (source of truth).
Patterns used: `skill_suggestion` (two-call rank + rerank), `confidence-routing`, `intent-routing`.

## Why: speed and cost

Jev answers typed questions in milliseconds at $0.042/Mtok input (output free).
The plugin spends fractions of a cent per turn to avoid mistakes that cost full
LLM turns. Reference numbers from TypeSafe cookbooks (488 requests, 182-skill
roster; our roster is smaller, so per-call cost is lower):

- Wrong skill loads 16.8% -> 7.3%, needless loads 9.8% -> 4.0%
  ([skill_suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)).
  Each prevented miss saves a wasted turn: a full `SKILL.md` in context at LLM
  prices plus the tool calls it triggers.
- Independent questions batch into one request (Choice + gate Nouls = 1 round
  trip): 12.2x cheaper, 10.0x faster than separate calls
  ([parallel_questions](https://docs.typesafe.ai/cookbooks/parallel_questions.md)).
- Per-turn overhead is ~0.3-0.5s of Jev calls. Net win when that prevents even
  one wasted multi-second turn.
- Permission gating (`autoPermission`) removes human-prompt wait on routine
  actions; the `stop` verifier catches incomplete work before the session ends
  instead of paying full re-investigation later.

Caveats: the hook taxes every turn, so the win depends on your wrong-load rate.
Thresholds (`gateThreshold`, `fitsThreshold`, default 0.3) were validated on
our 26-task offline set — see the evaluation below. Keep `autoPermission`
off until the permission mix scores acceptably.

## Evaluation (preview)

> Live v2 on 26 tasks via OpenRouter `typesafe/jev-1.13` (2 runs, ~$0.0009
> billed each, 0 errors). Full report with sweep grids and per-task scores:
> [`docs/eval.md`](docs/eval.md). Raw runs: `docs/eval-live-run1.json`,
> `docs/eval-live-run2.json`.

| Decision point | Verdict |
|:---------------|:--------|
| 🧭 Context steering | **KEEP** — 9/16 correct run1 (8/16 run2) vs 4/16 LLM-alone, 0 needless, ~$0.00004/turn |
| 🛡️ Permission gating (`autoPermission`) | **HOLD (keep `false`)** — 6/6 both runs, but hard `ask` at confidence 0.26–0.33 |
| 🛑 Stop verifier | **KEEP** — 2 true catches, 1 false alarm, bounded by `loop_limit: 3` |

Thresholds locked at `0.3` / `0.3` (gate cliff at 0.4, fits flat 0.2–0.5).
Reproduce: `bun test tests/` · `bun tests/eval-harness.ts --live` (needs key in `.env`).

## Judgements (preview)

> Beyond skill steering: tool-call steering (redirect), clarify-vs-act (block),
> failure advisor, subagent routing, and two-stage code review with
> reviewer-model selection. Live-trial status (small-n buckets, 75 Jev calls,
> $0.00145) — hard modes gated by confidence, fail open, audit-trailed.
> Full design + per-bucket results: [`docs/judgements.md`](docs/judgements.md).

| Judgement | Live signal |
|:----------|:------------|
| 🔧 Tool steering | 3/3 correct redirects, 0 wrong; redundancy caught |
| ❓ Clarify-vs-act | 3/4 (4th is a defensible auth-path ask) |
| 🔁 Failure advisor | 3/4 exact, 4/4 safe (never blind-retries harm) |
| 🧭 Subagent routing | implemented, unscored (needs your roster) |
| 🔍 Code review | 4/6 types, 2/2 nothings; over-escalates ≤1 rung, never under |

Configure: `toolSteering`, `clarify`, `failureAdvisor`, `subagentRouting`,
`review` (`off`/`suggest`/`redirect`|`block`) + `reviewTrigger` (`stop`/`edits`/`both`,
default `stop`) and `reviewModel` (`auto` or pinned id). See `opencode.jsonc`.

## Requirements

- One API key: `TYPESAFE_API_KEY` (https://console.typesafe.ai/keys) **or**
  `OPENROUTER_API_KEY` (https://openrouter.ai/settings/keys). `TYPESAFE_API_KEY`
  wins when both are set. To use [Nace](#nace-backend) instead, `NACE_API_KEY`
  plus an explicit `JEV_PROVIDER=nace`; a Nace key alone does not select Nace.
- No GPU, no local model. Jev is hosted by TypeSafe, directly or through
  OpenRouter, and Nace's Drex models are hosted by Nace.

| Provider | Endpoint | Default model |
| --- | --- | --- |
| TypeSafe direct | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| OpenRouter | `POST https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` (pinned; use `~typesafe/jev-latest` to track releases) |
| Nace (explicit) | `POST https://console.nace.ai/v1/systemone` | `drex-max-v1.1` (a fixed model id) |

Same question shape on TypeSafe and OpenRouter; OpenRouter adds `usage.cost` per
call. Both price Jev at $0.042 per Mtok input, output free. Tutorial:
https://openrouter.ai/docs/guides/community/jev-tutorial

## Layout

```
skills/jev-router/SKILL.md      agent skill (drop into ~/.agents/skills or .opencode/skills)
plugins/jev-router/             OpenCode v2 plugin (published unit)
plugins/jev-router/jev.ts       shared client + all judgement question builders
.cursor/hooks.json              Cursor hook wiring
.cursor/hooks/*.py              Cursor hook scripts (stdlib only)
opencode.jsonc                  example consumer config
docs/eval.md                    skill-steering eval (live v2)
docs/judgements.md              new-judgement eval (live trial)
```

## OpenCode quickstart

```sh
opencode plugin add 'git+https://github.com/drmaas/jev-router.git#path:plugins/jev-router'
export TYPESAFE_API_KEY=ts- replace-with-real-key
# ...or use OpenRouter instead:
export OPENROUTER_API_KEY=sk-or- replace-with-real-key
```

Or local path during development:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/home/drmaas/Projects/github/drmaas/jev-router/plugins/jev-router" },
  ],
}
```

See `opencode.jsonc` in this repo for a full example with options.

## Cursor quickstart

Copy `.cursor/hooks.json` and `.cursor/hooks/` into the project root,
then set `TYPESAFE_API_KEY`. Hooks fail open (allow) when the key is missing
or the API is unreachable, and log to stderr.

## Skill quickstart

```sh
mkdir -p ~/.agents/skills/jev-router
cp skills/jev-router/SKILL.md ~/.agents/skills/jev-router/SKILL.md
```

The upstream TypeSafe skill (teaches the LLM to write TypeSafe calls) is separate:
https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md

## Nace backend

[Nace](https://console.nace.ai) runs Drex, a decision model that answers the same typed `choice`,
`noul` and `score` questions at `POST /v1/systemone`. The question builders, thresholds, timeouts
and fail-open behavior are unchanged. Under Nace the decisions come from a Drex model, not from Jev.

Nace is opt-in. Only `JEV_PROVIDER=nace` or `provider: "nace"` in the OpenCode plugin options
selects it. A `NACE_API_KEY` alone does not. While Nace is selected the `TYPESAFE_*`, `OPENROUTER_*`
and `JEV_ENDPOINT` variables and the plugin's generic `apiKey`, `endpoint` and `model` options are
ignored, because they are TypeSafe and OpenRouter settings (this repo's own `opencode.jsonc` sets
`model` to `jev-latest`).

To get a key, [sign in and create one on the API Keys page](https://console.nace.ai/dashboard/api-keys?utm_source=jev-router&utm_medium=integration&utm_campaign=harness-launch&utm_content=setup-page).
Nace bills each successful request (HTTP 200) per input token, see [pricing](https://console.nace.ai/docs/drex/reference/pricing).
A request is refused with 402 when the balance runs out and pay as you go is off. With a saved card
and pay as you go on, usage continues.

| Variable | Meaning | Default |
| --- | --- | --- |
| `JEV_PROVIDER` | New. One of `typesafe`, `openrouter` or `nace`. OpenCode also accepts `provider` in the plugin options, which wins over the variable. The name is not case sensitive. Any other value prints the valid values and skips Jev | unset, so the provider is picked by key as above |
| `NACE_API_KEY` | Your `nace_sk_` key | none, calls are skipped |
| `NACE_MODEL` | One of the ids on [Nace's public model list](https://console.nace.ai/models), which on 2026-11-11 names `drex-v2.0`, `drex-max-v1.1` and `drex-max-finance`. Only the first two were run on this repo's fixtures | `drex-max-v1.1`, a fixed model id |
| `NACE_BASE_URL` | API base URL. It must use https, or http to `localhost`, `127.0.0.1` or `[::1]`, and it must not contain credentials. Anything else is refused and nothing is sent (see Failures). The key goes to whatever host you name | `https://console.nace.ai/v1` |

- **Attribution.** Every request carries `X-Nace-Client: jev-router-opencode/<version>` (OpenCode
  plugin) or `jev-router-cursor/<version>` (Cursor hooks). It is a fixed string with the surface name
  and version, carries no user content, and lets Nace count requests by integration. The endpoint,
  key variable, default model, header and client names live in `nace.json`, kept identical in
  `plugins/jev-router/` and `.cursor/hooks/`.
- **Failures.** An HTTP error (401 bad key, 402 balance used up with pay as you go off, 422 a model the key cannot use, 429)
  prints one line on stderr with the status, the error type and the `request_id`, never the message
  or the key. A timeout, a refused connection or an unreadable response prints one line with the
  error's class only, with no status and no request id. A redirect is refused and counts as a
  failure. A `NACE_BASE_URL` the client will not send the key to prints
  `[jev-router] nace: refusing to send the key to <where>: <reason>` and sends nothing. In the plugin
  `<where>` is the URL's scheme, host and port, and in the hooks it is the host name only. Both print
  `that URL` when the URL has no host. `<reason>` is one of `the URL contains credentials`,
  `the scheme must be https`, `plain http is only allowed to localhost, 127.0.0.1 or ::1` and
  `not a valid URL`.
  Every failure then fails open as before. Nace is never retried on another provider. In OpenCode
  2.2.7 plugin stderr shows only with `--print-logs`, so a normal run prints nothing.
- **Outages.** Every call has a timeout: 8 seconds in the OpenCode plugin (the `timeoutMs` option) and
  12 seconds in the Cursor hooks. When Nace does not answer, each call waits that long and then fails
  open, so an outage adds the wait to every decision and never blocks the agent's work. The Cursor
  policy hook runs before each shell command and tool use, apart from a few read-only commands.
- **Proxy.** A loopback http call goes through `http_proxy` when one is set, and the proxy then sees
  the key. When you point `NACE_BASE_URL` at a local address, set
  `no_proxy=127.0.0.1,localhost,[::1]`. The OpenCode plugin and the hooks both need the bracketed
  `[::1]`, and a bare `::1` does not match.

OpenCode v2:

```sh
opencode plugin add 'git+https://github.com/drmaas/jev-router.git#path:plugins/jev-router'
export JEV_PROVIDER=nace NACE_API_KEY=nace_sk_replace-with-real-key
```

or choose it in the project's `opencode.jsonc`, with the key still in the environment:

```jsonc
{ "plugins": [{ "package": "git+https://github.com/drmaas/jev-router.git#path:plugins/jev-router",
                "options": { "provider": "nace" } }] }
```

Cursor: copy `.cursor/hooks.json` and the whole `.cursor/hooks/` folder (including `nace.json`),
and launch Cursor from a shell that has `JEV_PROVIDER=nace` and `NACE_API_KEY` exported, because
hooks inherit Cursor's environment.

### Where Drex did worse than Jev here

These are one-shot replays of 46 fixtures written and threshold-tuned for Jev, not a model benchmark. At the existing thresholds, the committed runs matched 38/46 expected labels for Jev 1.13, 37/46 for Drex Max v1.1, and 33/46 for Drex 2.0. Drex run-to-run variance was not measured.

The expected labels were written for Jev too. The thresholds (`gateThreshold`, `fitsThreshold`, the
stop, clarify and review cutoffs) were not retuned for Drex. To replay a model:
`JEV_PROVIDER=nace NACE_MODEL=<id> bun tests/eval-harness.ts --live`.

| Bucket | `jev-1.13` (run3) | `drex-max-v1.1` | `drex-v2.0` |
| --- | --- | --- | --- |
| Skill steering | 14/16 | 15/16 | 14/16 |
| Permission verdicts | 6/6 | 4/6 | 4/6 |
| Stop verifier | 3/4 | 4/4 | 3/4 |
| Tool steering | 5/6 | 4/6 | 5/6 |
| Clarify | 3/4 | 3/4 | 2/4 |
| Failure advisor | 3/4 | 3/4 | 3/4 |
| Review type | 4/6 | 4/6 | 2/6 |
| Total | 38/46 | 37/46 | 33/46 |

The Drex columns are in `docs/eval-nace-drex-max-v1.1.json` and `docs/eval-nace-drex-v2.0.json`.
They are one run each of the models `drex-max-v1.1` and `drex-v2.0`, made on 2026-11-11 with the gate
and fits thresholds at 0.3. The Jev column is the committed `docs/eval-live-run3.json`.

- **Permission verdicts.** Both Drex models answered `ask` where `deny` was expected on P06.
  `drex-max-v1.1` answered `allow` at 0.60 where `ask` was expected on P04. `drex-v2.0` answered
  `ask` at 0.22 on P02, where `allow` was expected.
- **Review type.** `drex-max-v1.1` sent R02 and R03 to `fresh`, the costliest review, where `routine`
  and `adversarial` were expected. Jev also misses those two, one rung up. `drex-v2.0` missed four
  of six. It answered `adversarial` on R02 (expected `routine`), `routine` on R03 (expected
  `adversarial`), `routine` on R04 and no review on R06 (both expected `fresh`).
- **Cursor.** The policy hook (`jev_policy.py`) is always on. Apart from a few read-only commands it
  asks for a verdict on every shell command and tool use. There is no switch like
  `autoPermission`, short of removing it from `hooks.json`. It lets an action through on `allow`, and on any verdict under its 0.30
  confidence floor. So `drex-max-v1.1`'s `allow` at 0.60 on P04 would run an action that should have
  asked, and `drex-v2.0`'s `ask` at 0.22 on P02 would be dropped to `allow`, which is what P02
  expects, though the eval counts the answer wrong. Under Nace the hook's `ask` and `deny` messages
  still read "Jev verdict".
- **OpenCode.** Keep `autoPermission` off, its default.

## What Jev is not

Jev does not generate text, write code, or call tools. There is no
`model: "jev-latest"` setting that powers a coding agent. Code owns the workflow;
Jev supplies typed judgments (`choice` / `noul` / `score`) with calibrated
probabilities. See https://docs.typesafe.ai/introduction/coding-agents.md.
