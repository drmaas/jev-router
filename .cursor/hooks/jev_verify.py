#!/usr/bin/env python3
"""Verifier for the `stop` hook. When the agent finishes, ask Jev whether the
task is actually done; if not, emit a followup_message to continue the loop.

Bounded by loop_limit in hooks.json (3) so a wrong verdict cannot loop forever.
Fails open (no followup) when the key is missing or the API errors.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from jev_client import system_one  # noqa: E402

DONE_THRESHOLD = 0.6
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


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        print("{}")
        return

    if payload.get("status") not in (None, "completed"):
        # Only verify clean completions; errors/aborts pass through silently.
        print("{}")
        return

    transcript_path = payload.get("transcript_path")
    context = read_tail(transcript_path) if transcript_path else ""
    summary = payload.get("summary", "") or ""
    state = {
        "task_summary": summary[:2000],
        "transcript_tail": context,
    }
    res = system_one(
        state=state,
        questions={
            "done": {
                "type": "noul",
                "instructions": "Has the user's request been fully completed in the transcript above, with no remaining steps, unverified claims, or failing tests?",
            }
        },
    )
    if not res:
        print("{}")
        return
    p_done = float(((res.get("answers") or {}).get("done") or {}).get("noul", 1.0))
    if p_done >= DONE_THRESHOLD:
        print("{}")
        return
    print(
        json.dumps(
            {
                "followup_message": (
                    f"Automated verification (confidence {1 - p_done:.2f} that work remains): "
                    "re-check the original request against what was actually done, "
                    "run the relevant tests, and finish or report what is incomplete."
                )
            }
        )
    )


if __name__ == "__main__":
    main()
