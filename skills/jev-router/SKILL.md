---
name: jev-router
description: >
  Route agent turns with TypeSafe Jev: rank skills or handlers with a Choice,
  gate with Nouls, verify with a stop-hook. Use when a turn needs a fast
  structured decision (routing, ranking, guardrails, verification) instead of
  another LLM call, or when wiring the jev-router OpenCode plugin / Cursor
  hooks in this repo.
---

# Jev routing

Jev is a System One model: it returns typed judgments, not text. Code owns the
workflow; Jev supplies the decision. Live docs are the source of truth:
https://docs.typesafe.ai/llms.txt

## When to use Jev vs the LLM

| Need | Tool |
| --- | --- |
| Pick one of a fixed set (skill, handler, subagent) | Jev `choice` |
| Check whether a condition holds (done? risky? urgent?) | Jev `noul` |
| Rate along a rubric (risk, quality, severity) | Jev `score` |
| Write code, prose, tool args, anything open-ended | LLM |

## The two-call shape (skill_suggestion cookbook)

1. **Rank wide:** one `choice` over the whole roster (one line per option) plus
   three gate `nouls` (`acts_on_user_system`,
   `would_follow_documented_procedure`, `prose_suffices` inverted) in a single
   `/v1/systemone` request. Mean of the oriented gates under 0.30 means suggest
   nothing.
2. **Rerank narrow:** same `choice` over the top 3 with full descriptions plus
   one `fits::<name>` noul per candidate. Best fits-noul under 0.30 means
   suggest nothing. Otherwise suggest the winner, at most one name.

Reference: https://docs.typesafe.ai/cookbooks/skill_suggestion.md

## Confidence routing

The answer says *what*; confidence says *whether to act*. Low confidence falls
back to the LLM, never to a guess. Reference:
https://docs.typesafe.ai/patterns/confidence-routing.md

## In this repo

- OpenCode plugin: `plugins/jev-router/` — turn steering (`session.hook("context")`),
  tool-call steering (`tool.hook("execute.before")`, redirect on confidence),
  clarify-vs-act + opt-in permission gating (`permission.hook("evaluate")`,
  `autoPermission: true`), failure advisor (`tool.hook("execute.after")`),
  subagent routing, code review (`reviewTrigger: stop|edits|both`, default `stop`;
  reviewer model picked from the live roster when `reviewModel: auto`).
  Shared client + distiller + judgement builders: `plugins/jev-router/jev.ts`.
- Cursor hooks: `.cursor/hooks.json` with `.cursor/hooks/jev_policy.py`
  (`beforeShellExecution`, `preToolUse`) and `.cursor/hooks/jev_verify.py` (`stop`).
- Auth: `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` (auto-detected; all calls fail open without one).
- Providers: TypeSafe direct (`/v1/systemone`, `jev-latest`) or OpenRouter
  (`/api/alpha/decisions`, `typesafe/jev-1.13`). Set `provider` explicitly to
  override auto-detect.
- State budget: distil transcripts to ~4000 chars (`request` + `recent_context`).
  Jev caps `state` at 32k tokens; never send a raw transcript.

## API reminder

`POST {endpoint}/v1/systemone` with `Authorization: Bearer <key>`:

```json
{
  "state": {"request": "...", "recent_context": "..."},
  "questions": {
    "which": {"type": "choice", "instructions": "...", "criteria": {"a": "..."}},
    "risky": {"type": "noul", "instructions": "..."}
  },
  "model": "jev-latest"
}
```
