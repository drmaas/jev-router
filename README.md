# jev-router

System One routing for coding agents. Jev decides, LLM generates.

- **OpenCode v2 plugin** (`plugins/jev-router/`): turn steering via `session.hook("context")`,
  permission gating via `permission.hook("evaluate")`, on-demand decisions via a `jev_ask` tool.
- **Cursor hooks** (`.cursor/`): `beforeShellExecution` policy gate + `stop` verifier, stdlib-only Python.
- **Skill** (`skills/jev-router/SKILL.md`): teaches an agent when to reach for Jev vs the LLM.

Upstream API docs: https://docs.typesafe.ai/llms.txt (source of truth).
Patterns used: `skill_suggestion` (two-call rank + rerank), `confidence-routing`, `intent-routing`.

## Requirements

- `TYPESAFE_API_KEY` in the environment (https://console.typesafe.ai/keys).
- No GPU, no local model. Jev is hosted: `POST https://api.typesafe.ai/v1/systemone`.

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
