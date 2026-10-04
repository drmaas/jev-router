# jev-router

System One routing for coding agents. Jev decides, LLM generates.

- **OpenCode v2 plugin** (`plugins/jev-router/`): turn steering via `session.hook("context")`,
  permission gating via `permission.hook("evaluate")`, on-demand decisions via a `jev_ask` tool.
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
Thresholds (`gateThreshold`, `fitsThreshold`, default 0.3) are cookbook starting
points, not tuned values. See the evaluation plan in the issue tracker before
enabling `autoPermission`.

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
.cursor/hooks.json              Cursor hook wiring
.cursor/hooks/*.py              Cursor hook scripts (stdlib only)
opencode.jsonc                  example consumer config
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
