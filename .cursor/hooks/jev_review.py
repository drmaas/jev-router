#!/usr/bin/env python3
"""Review gate for the `stop` hook. When the agent finishes, ask Jev whether
the change warrants review and, if so, which intensity:
routine (same-context checklist), adversarial (try to break it), or fresh
(fresh-context review on another model).

Mode comes from JEV_REVIEW_MODE (suggest|redirect, default suggest).
In suggest mode only routine/adversarial emit a followup; fresh-context is
reported as text for the user to trigger (the hook cannot spawn subagents).
In redirect mode every non-nothing verdict emits a followup requiring the
review pass. Fails open (no followup) when the key is missing or the API errors.

Like jev_verify.py, bounded by loop_limit in hooks.json.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from jev_client import system_one  # noqa: E402

NEEDS_REVIEW_THRESHOLD = 0.5
MODE = os.environ.get("JEV_REVIEW_MODE", "suggest").strip().lower()
REVIEW_MODEL = os.environ.get("JEV_REVIEW_MODEL", "auto").strip()
TAIL_CHARS = 6000


def read_tail(path, limit=TAIL_CHARS):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - limit))
            return f.read()[-limit:]
    except Exception:
        return ""


def quiet():
    print("{}")


def followup(text):
    print(json.dumps({"followup_message": text}))


REVIEW_BRIEFS = {
    "routine": (
        "Routine review required: checklist the diff for bugs, edge cases, "
        "and missing tests before finishing."
    ),
    "adversarial": (
        "Adversarial review required: actively try to break the change — "
        "security holes, invariant violations, hostile inputs — before finishing."
    ),
    "fresh": (
        "Fresh-context review required{model}: delegate the diff to a reviewer "
        "with no prior transcript{model2}, then address findings before finishing."
    ),
}


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        quiet()
        return

    if payload.get("status") not in (None, "completed"):
        quiet()
        return

    transcript_path = payload.get("transcript_path")
    context = read_tail(transcript_path) if transcript_path else ""
    summary = payload.get("summary", "") or ""
    state = {
        "task_summary": summary[:2000],
        "transcript_tail": context,
    }

    gate = system_one(
        state=state,
        questions={
            "needs_review": {
                "type": "noul",
                "instructions": "Did recent changes touch logic, auth, data paths, money, or public APIs — anything where a bug would cost more than a review turn? Typo/comment-only changes do not warrant review.",
            }
        },
    )
    if not gate:
        quiet()
        return
    p_need = float(((gate.get("answers") or {}).get("needs_review") or {}).get("noul", 0))
    if p_need < NEEDS_REVIEW_THRESHOLD:
        quiet()
        return

    typed = system_one(
        state=state,
        questions={
            "review": {
                "type": "choice",
                "instructions": "Recent changes may warrant review. Pick the cheapest review that covers the risk. Cost ladder: routine (~1 turn, same context checklist) < adversarial (~1-2 turns, actively try to break it) < fresh (~2+ turns on a second model with no prior transcript, only for auth/money/data-loss paths or large diffs). Pick nothing when no review is worth a turn.",
                "criteria": {
                    "routine": "Same-context checklist: bugs, edge cases, missing tests",
                    "adversarial": "Hostile review: security holes, invariant violations, malicious inputs",
                    "fresh": "Fresh-context review on another model: de-anchored second opinion for high-stakes diffs",
                    "nothing": "No review worth a turn",
                },
            }
        },
    )
    if not typed:
        quiet()
        return
    kind = ((typed.get("answers") or {}).get("review") or {}).get("choice")
    if kind not in REVIEW_BRIEFS:
        quiet()
        return
    if MODE != "redirect" and kind == "fresh":
        # Suggest mode cannot spawn a subagent; surface as text, no loop.
        print(json.dumps({"user_message": "Jev suggests a fresh-context code review (set JEV_REVIEW_MODE=redirect to enforce)."}))
        return
    model_txt = "" if REVIEW_MODEL in ("", "auto") else f" on model '{REVIEW_MODEL}'"
    brief = REVIEW_BRIEFS[kind].format(model=model_txt, model2=model_txt)
    followup(f"Automated review gate: {brief}")


if __name__ == "__main__":
    main()
