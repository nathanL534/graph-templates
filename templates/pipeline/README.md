# pipeline

A general-purpose graph: **intake → research ‖ setup → draft → review → approve → execute → log**.

```bash
bun install
bun run plan                         # each step's resolved contract
bun run demo                         # offline run with a fake agent: retry, review → send back, human pause, approve, done
graph run <key> --input request.md   # real run (claude -p); artifacts in runs/<key>/
graph status <key>
```

- `graph.config.ts`: the graph. Edit steps, checks and overrides here.
- `nodes/<step>.md`: the brief each agent step follows. Start new ones from `nodes/_TEMPLATE.md`.
- `runs/`: run artifacts. Gitignored.
- `tracker.jsonl`: the default tracker the `log` step upserts into, one row per run key. Gitignored.

When the run pauses at `approve`, read `runs/<key>/draft.md`, then either `touch runs/<key>/APPROVED` or write your reasons to `runs/<key>/REJECTED` (that sends `draft` back with them). Then `graph run <key>` again.
