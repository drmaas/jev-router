# jev-router

System One routing for coding agents. Jev decides, LLM generates.

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
  wins when both are set.
- No GPU, no local model. Either way Jev is hosted.

| Provider | Endpoint | Default model |
| --- | --- | --- |
| TypeSafe direct | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| OpenRouter | `POST https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` (pinned; use `~typesafe/jev-latest` to track releases) |

Same question shape on both; OpenRouter adds `usage.cost` per call. Same price:
$0.042 per Mtok input, output free. Tutorial:
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
opencode plugin add github:drmaas/jev-router
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

## What Jev is not

Jev does not generate text, write code, or call tools. There is no
`model: "jev-latest"` setting that powers a coding agent. Code owns the workflow;
Jev supplies typed judgments (`choice` / `noul` / `score`) with calibrated
probabilities. See https://docs.typesafe.ai/introduction/coding-agents.md.
