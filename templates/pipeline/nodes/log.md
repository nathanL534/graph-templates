# Log

> Contract: the `log` step in `graph.config.ts` (`graph plan` shows the resolved checks)

## Purpose
Record the run in the tracker and prove the write landed.

## Steps
1. The default tracker is `$GRAPH_ROOT/tracker.jsonl`: one JSON object per line, keyed by `key`. This is the one file outside the run folder you may write.
2. Build the row: `{ "key": "<$GRAPH_KEY>", ...whatever this run should record }`. At least one field besides `key`.
3. Upsert it: replace the line whose `key` equals `$GRAPH_KEY`, or append if there is none. Create the file if it is missing.
4. Read the row back from the tracker, not from your own variable.
5. Save both in `log.json` as `{ "written": {...}, "readBack": {...} }`.

## Pitfalls
- The check compares every key in `written` against `readBack`, order-insensitive, and prints the keys that differ. Extra keys in `readBack` are fine; missing or changed ones are not.
- If the project uses another tracker (a sheet, a database), `request.md` or `README.md` says so. Same contract: write, read back, save both.
