---
name: graph
description: Build and run deterministic agent pipelines with the `graph` CLI (graph-templates). Use when the user wants to scaffold a graph, add or wire nodes, override a node's contract, or run a graph end to end ("make a graph", "add a node", "run the graph", "graph init", "why did this step block").
---

# graph

A graph is a list of steps in `graph.config.ts`. Each step does work, is verified against its contract, and retries with the failures as feedback. The next step starts only when this one passes. The runner does the chaining; state lives in `runs/<key>/.graph/state.json`.

## Commands
```
graph init [dir] [--template pipeline]   scaffold (then: bun install)
graph templates                          list templates
graph plan                               lint + print each step's resolved contract and where each check came from
graph run <key> [--input <file>]         run or resume; --input is copied to runs/<key>/input.md and hashed into every step
graph status <key>                       per-step state
graph skill                              install this skill into ~/.claude/skills/graph
  --config <path>                        any command: another config (default ./graph.config.ts)
```
Exit codes: 0 done/ok · 1 blocked, goal failed, over budget, lint errors · 2 usage error (missing argument, no config, no input file) · 3 waiting on a human.

## Node kinds and their default contracts
| Builder | Does the work | Default checks | retries | when retries run out |
|---|---|---|---|---|
| `agent(name, { brief, outputs })` | an LLM follows `brief` | each output exists and is non-empty | 2 | block |
| `script(name, { run, outputs })` | a shell command | each output exists | 0 | block |
| `effect(name, { brief or run, replay, readback })` | changes the outside world | outputs, `replay`, `readback` exist; `bash -n replay`; every readback field expected === actual; `verify` command exits 0 if given | 1 | block |
| `check(name, { of, reads, rubric })` | a separate reviewer agent | verdict file ends `Verdict: PASS` | 1 | block (a written FAIL goes to `onExhausted`, default `back(of)`, at once) |
| `human(name, { instructions, rejectTo? })` | a person | `APPROVED` exists | 0 (always) | block |

Enforced by the runner, not listed as checks: a script/effect command that exits non-zero fails the attempt; a reviewer that modifies a file in `reads` fails the attempt and its edits are undone.

A `check` goes to its `onExhausted` (default `back(of)`: re-run `of` with the verdict as feedback) only on a written `Verdict: FAIL`, at once. A crash, a missing verdict, or tampering is retried once, then blocks.

`parallel(a, b)` runs steps at the same time. Optional step fields: `optionalOutputs` (agent, script: may or may not be written; hashed and cleared, never required), `model`, `tools` (agent, effect, check), `verify` (effect: a command the runner runs to read the result back from the target), `file` and `rejectTo` (human).

## Overriding a contract
Per step, or per kind through `defaults: { agent: {...} }` in the graph:
- `checks: [...]` adds checks. A check with the same `id` as a default replaces it.
- `skip: ["non-empty:x.md"]` drops a default check.
- `retries`, and `onExhausted: "block" | back("step")`.

Build checks with `checks as c`: `c.fileExists`, `c.nonEmpty`, `c.sections`, `c.matches`, `c.forbids`, `c.json`, `c.command`, `c.anyOf`, `c.verdictPassed`, `c.noSecrets`. Builder default ids: `exists:<path>`, `non-empty:<path>`, `sections:<path>`, `matches:<path>`, `forbids:<path>`, `json:<path>`, `command:<first 40 chars>`, `verdict:<step>`, `no-secrets`. Kind default ids (what `skip` takes): `exists:<output>`, `non-empty:<output>` (agent), `exists:<output>` (script), `exists:<file>`, `replay-non-empty`, `replay-parses`, `readback-matches`, `verify-target` (effect), `verdict-pass` (check), `approved` (human). Give every custom check an `id` and a `why`; the agent sees the `why` when it fails.

Graph level: `invariants` run after every step (a scan like `c.noSecrets` covers only that step's outputs), `goal` runs once at the end, `budget: { minutes, maxReentries }` (a running step's process is killed at the deadline; maxReentries defaults to 2).

## What the runner does between steps
- Before each attempt (human steps excepted), the step's outputs are moved to `runs/<key>/.graph/prev/<step>/`. A do-nothing retry fails.
- Each step records a hash of `input.md` plus everything produced upstream. Any change resets every later step that passed or was waiting, and revokes its approval.
- `APPROVED` or `REJECTED` counts only if written while that exact version was waiting; a stale one is deleted. `REJECTED` sends the run back to `rejectTo` with the file's contents as feedback.
- An agent or script retry gets every failed check and its `why` (prompt + `GRAPH_FEEDBACK` file). Feedback from a step that sent this one back ("Sent back by ...") stays there across the step's own retries. A reviewer's retry prompt carries no feedback; its previous failures are only in the `GRAPH_FEEDBACK` file.
- Steps run inside `runs/<key>/` with `GRAPH_ROOT`, `GRAPH_KEY`, `GRAPH_STEP`, `GRAPH_ATTEMPT`, `GRAPH_FEEDBACK` set (reviewers also `GRAPH_VERDICT`). `claude()` spawns `claude -p --permission-mode acceptEdits` plus `--allowedTools` from `tools`.

## Adding a node
1. Write the brief at `nodes/<name>.md`: purpose, steps, pitfalls. Name the exact files and headings the checks look for.
2. Add the step to `graph.config.ts` in the right position. Declare `outputs`; add checks for what "done" means.
3. To verify it with a separate agent, add `check("<name>-review", { of: "<name>", reads, rubric })` right after it.
4. Run `graph plan` until it prints `ok`.

## Rules
- Never write `runs/<key>/APPROVED` or `REJECTED` yourself. Only the human does.
- Never report a step or a run as done unless `graph status <key>` says so.
- When a step blocks, read `runs/<key>/.graph/state.json` (its `feedback`) and the logs in `.graph/logs/` before changing anything.
- `runs/` holds real data and is gitignored. Keep it that way.
- Try a config change offline first: `GRAPH_AGENT_CMD="bash $PWD/examples/fake-agent.sh" graph run <key> --input examples/demo/input.md`.
