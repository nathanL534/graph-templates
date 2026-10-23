# Intake

> Contract: the `intake` step in `graph.config.ts` (`graph plan` shows the resolved checks)

## Purpose
Turn the raw request in `input.md` into `request.md`: a written goal with checkable done-conditions.

## Steps
1. Read `input.md` in the run folder. If it is missing, the run was started without `--input`; use the request given in your prompt.
2. Write `request.md` with exactly these three headings, each non-empty:
   - `## Goal`: the request restated as one paragraph.
   - `## Constraints`: hard limits as bullets (scope, budget, things that must not happen).
   - `## Done When`: a `- [ ]` checklist. Each item must be verifiable by reading a file or running a command.

## Pitfalls
- "Make it good" is not a done-condition. If you can't check an item, rewrite it until you can.
- The checklist has to sit directly under `## Done When`, before any other heading, or the `done-is-checklist` check fails.
