#!/usr/bin/env python3
"""Policy gate for `beforeShellExecution` and `preToolUse`.

Reads the hook JSON from stdin, asks Jev for a verdict, prints the hook
output JSON to stdout. Fails open (allow) when the key is missing, the API
errors, or confidence is below threshold.

Auto-detection: payloads with a "command" field are shell executions;
payloads with "tool_name" are generic tool uses.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from jev_client import system_one  # noqa: E402

CONFIDENCE_THRESHOLD = 0.30

SAFE_PREFIXES = (
    "ls ",
    "pwd",
    "echo ",
    "cat ",
    "head ",
    "tail ",
    "git status",
    "git diff",
    "git log",
)


def allow():
    print(json.dumps({"continue": True, "permission": "allow"}))


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        allow()
        return

    command = payload.get("command", "")
    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {})
    action = command or f"{tool_name} {json.dumps(tool_input)[:500]}"
    if not action.strip():
        allow()
        return

    # Cheap static fast-path: read-only shell commands skip the API call.
    if command and command.strip().startswith(SAFE_PREFIXES):
        allow()
        return

    res = system_one(
        state={
            "pending_action": action[:2000],
            "cwd": payload.get("cwd", ""),
        },
        questions={
            "verdict": {
                "type": "choice",
                "instructions": "The coding agent wants to perform this action. Should it proceed automatically, ask the user first, or be denied?",
                "criteria": {
                    "allow": "Safe, routine, and reversible in this context",
                    "ask": "Potentially destructive, surprising, or needs human judgement",
                    "deny": "Dangerous, exfiltrative, or clearly outside the task",
                },
            }
        },
    )
    if not res:
        allow()
        return
    ans = (res.get("answers") or {}).get("verdict") or {}
    verdict = ans.get("choice")
    confidence = float(ans.get("confidence", 0))
    if verdict not in ("allow", "ask", "deny") or confidence < CONFIDENCE_THRESHOLD:
        allow()
        return
    if verdict == "allow":
        allow()
        return
    print(
        json.dumps(
            {
                "continue": True,
                "permission": verdict,
                "user_message": f"Jev verdict: {verdict} (confidence {confidence:.2f}) for: {action[:120]}",
                "agent_message": f"A System One policy check returned '{verdict}' with confidence {confidence:.2f}. When 'ask', wait for the user; when 'deny', choose a safer alternative.",
            }
        )
    )


if __name__ == "__main__":
    main()
