# <Step name>

> Contract: the `<name>` step in `graph.config.ts` (`graph plan` shows the resolved checks).

## Purpose
One sentence. What exists after this step that did not exist before?

## Steps
1. Read the files this step depends on.
2. Do the work.
3. Write each declared output to its exact path.

The runner moves the previous attempt's outputs to `.graph/prev/<name>/` before each attempt and checks the contract after you finish. On a failure, your next attempt's prompt lists every failed check and why it exists.

## Pitfalls
Failures that actually happened, each with the date and the fix. When one repeats, turn it into a check in `graph.config.ts`.
