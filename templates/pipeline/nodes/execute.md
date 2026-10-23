# Execute

> Contract: the `execute` step in `graph.config.ts` (`graph plan` shows the resolved checks). Runs after review passed and a human approved. Has Bash.

## Purpose
Apply the approved draft to the real target, recording every action and reading back what actually landed.

## Steps
1. Write each action to `replay.sh` as you perform it, not afterwards. It must parse (`bash -n replay.sh`).
2. After each write, read the value back from the target itself, not from your own command output.
3. Record `{ "field", "expected", "actual" }` per write in `readback.json` under `fields`. Every `actual` must equal its `expected`.

## Pitfalls
- If the target resets mid-run, re-run `replay.sh`. Don't improvise the steps again.
- An empty `fields` array passes nothing: the check needs at least one read-back.
