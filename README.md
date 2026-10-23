# graph-templates

Deterministic agent pipelines. You list steps in a config file. Each step **does the work, gets verified against its contract, and retries with the failures as feedback**, and the runner moves on only when it passes. No agent ever decides for itself that it's done.

```ts
// graph.config.ts
import { agent, check, defineGraph, effect, human } from "graph-templates";

export default defineGraph({
  name: "pipeline",
  steps: [
    agent("research", { brief: "nodes/research.md", outputs: ["research.md"] }),
    agent("draft",    { brief: "nodes/draft.md",    outputs: ["draft.md"] }),
    check("review",   { of: "draft", reads: ["research.md", "draft.md"], rubric: "Every claim is supported." }),
    human("approve",  { instructions: "Read draft.md.", rejectTo: "draft" }),
    effect("publish", { brief: "nodes/publish.md", replay: "replay.sh", readback: "readback.json" }),
  ],
});
```

`review` writes `Verdict: FAIL` → `draft` re-runs with the reviewer's verdict as feedback → repeat, up to a budget. A human who writes `REJECTED` instead of `APPROVED` sends `draft` back the same way.

## Install

```bash
bunx github:nathanL534/graph-templates init my-graph   # or: bun add -g github:nathanL534/graph-templates
cd my-graph && bun install
bun run plan                        # lint the graph, print every step's resolved contract
bun run demo                        # the whole loop offline, with a fake agent
graph run <key> --input request.md  # for real (uses `claude -p` by default)
```

To use it from Claude Code, run `graph skill`. That installs `~/.claude/skills/graph`, so Claude knows how to scaffold, wire and run graphs.

## CLI

```
graph init [dir] [--template pipeline]   scaffold a project from a template (then: bun install)
graph templates                          list templates
graph plan                               lint graph.config.ts, print each step's resolved contract and where each check came from
graph run <key> [--input <file>]         run or resume run <key>; --input is copied to runs/<key>/input.md and hashed into every step
graph status <key>                       per-step state for run <key>
graph skill                              install the Claude Code skill into ~/.claude/skills/graph
  --config <path>                        any command: use another config (default ./graph.config.ts)
```

Exit codes: `0` done (or ok) · `1` blocked, goal failed, over budget, or lint errors · `2` usage error (missing argument, no config, no input file, unknown command) · `3` waiting on a human.

## Node kinds: each has a default contract

| Kind | Does the work | Default checks | Retries | When retries run out |
|---|---|---|---|---|
| `agent` | an LLM following a brief | each output exists and is non-empty | 2 | block |
| `script` | a shell command | each output exists | 0 | block |
| `effect` | changes the outside world | outputs, `replay` and `readback` exist; `replay` is non-empty and parses (`bash -n`); every `readback` field has `expected === actual`; `verify` command exits 0, if given | 1 | block |
| `check` | a *separate* reviewer agent | the verdict file ends with `Verdict: PASS` | 1 | block (a written FAIL goes to `onExhausted`, default `back(of)`, at once) |
| `human` | you | `APPROVED` exists | 0 (always) | block |

Two rules are enforced by the runner itself, not by a check in the table: a `script` or `effect` command that exits non-zero fails the attempt even if its outputs exist, and a `check` reviewer that modifies any file in `reads` fails the attempt and has its edits undone.

A `check` step's `onExhausted` (default `back(of)`) is where a **written** `Verdict: FAIL` goes, at once and without using a retry: `of` re-runs with the verdict as feedback. The retries cover only a reviewer that crashes, writes no verdict, or edits what it reviews; when they run out the run blocks. So a retry of a `check` is never a second opinion on the work, and `onExhausted: "block"` on a `check` makes a FAIL block too.

### Overrides
```ts
import { agent, back, checks as c, defineGraph } from "graph-templates";

export default defineGraph({
  name: "pipeline",
  defaults: { agent: { retries: 3 } },                  // every agent step
  steps: [
    agent("research", { brief: "nodes/research.md", outputs: ["research.md"] }),
    agent("draft", {
      brief: "nodes/draft.md",
      outputs: ["draft.md"],
      checks: [c.sections("draft.md", ["Summary"])],    // added
      skip: ["non-empty:draft.md"],                     // a default dropped
      onExhausted: back("research"),                    // re-enter an earlier step instead of blocking
    }),
  ],
});
```
Layering order: kind default → graph `defaults[kind]` → step. A check with the same `id` replaces one from a lower layer. `graph plan` shows where each check came from.

Builders: `c.fileExists`, `c.nonEmpty`, `c.sections`, `c.matches`, `c.forbids`, `c.json`, `c.command`, `c.anyOf`, `c.verdictPassed`, `c.noSecrets`. Their default ids are `exists:<path>`, `non-empty:<path>`, `sections:<path>`, `matches:<path>`, `forbids:<path>`, `json:<path>`, `command:<first 40 chars>`, `verdict:<step>`, `no-secrets`; pass `{ id, why }` to override. The ids of the kind defaults, for `skip`: `exists:<output>` and `non-empty:<output>` (agent), `exists:<output>` (script), `exists:<file>`, `replay-non-empty`, `replay-parses`, `readback-matches` and `verify-target` (effect), `verdict-pass` (check), `approved` (human).

Step options beyond the contract: `outputs`; `optionalOutputs` on agent and script steps (files a step may write; hashed and cleared like outputs, never required); `model` and `tools` on agent, effect and check steps; `verify` on effect steps (a command the runner runs itself to read the result back from the real target); `file` and `rejectTo` on human steps.

## What the runner guarantees
- **Feedback loop:** an agent or script step's retry gets every failed check and its `why`, in the prompt and in the `GRAPH_FEEDBACK` file. Feedback from a step that sent this one back (a reviewer's verdict, a human's rejection) stays there across the step's own retries. A `check` reviewer's retry prompt carries no feedback (its previous failures are only in the `GRAPH_FEEDBACK` file): a reviewer's failures are the runner's business, not the work's.
- **Clean attempts:** before each attempt (human steps excepted), the step's outputs are moved to `runs/<key>/.graph/prev/<step>/`. An attempt that does nothing fails; it cannot pass on the previous attempt's files.
- **Resume:** state is in `runs/<key>/.graph/state.json`. Re-running picks up where it stopped.
- **Staleness:** each step records a hash of `input.md` plus everything produced upstream. If any of it changes, every later step that passed or was waiting is reset and re-runs.
- **Human gates:** an `APPROVED` (or `REJECTED`) file counts only if it was written while that exact version was waiting; one placed earlier, or before an upstream change, is deleted. `REJECTED` sends the run back to `rejectTo` with the file's contents as feedback.
- **Bounds:** per-step retries, a re-entry cap (`budget.maxReentries`, default 2), and a time budget (`budget.minutes`) at which a running step's process is killed.
- **Invariants and goal:** `invariants` are checked after every step (a scan like `c.noSecrets` covers only that step's outputs, not the whole run folder); `goal` once at the end.
- **Your data stays local:** `runs/` is gitignored in every scaffolded project.

Agents and scripts run inside `runs/<key>/` with `GRAPH_ROOT`, `GRAPH_KEY`, `GRAPH_STEP`, `GRAPH_ATTEMPT` and `GRAPH_FEEDBACK` (path of the feedback file) set; reviewers also get `GRAPH_VERDICT`. The default `claude()` runner spawns `claude -p` with `--permission-mode acceptEdits`, adds `--allowedTools` from the step's `tools`, and `extraArgs` replaces the permission flag. Set `GRAPH_AGENT_CMD` to run any command in place of the agent (the demo uses a bash script).

## Templates
| Template | |
|---|---|
| [`pipeline`](templates/pipeline) | intake → research ‖ setup → draft → review → approve → execute → log |

Add one: `templates/<name>/` with a `graph.config.ts`, `nodes/`, `package.template.json`, `gitignore.template`, and an offline demo that runs to `done`.

## Develop
```bash
bun install && bun link   # puts `graph` on your PATH
bun test && bun run typecheck && bun run demo
cd verify && graph run <key>   # the repo verifies itself with its own runner (docs review uses `claude -p`)
```

## License
MIT
