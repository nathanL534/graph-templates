# Draft

> Contract: the `draft` step in `graph.config.ts` (`graph plan` shows the resolved checks)

## Purpose
Produce the deliverable and an auditable ledger of every factual claim in it.

## Steps
1. Read `request.md` and `research.md`.
2. Write `draft.md` so that every item under `## Done When` in `request.md` is satisfied. The reviewer ticks them one by one.
3. For every factual sentence in the draft, add `{ "text": ..., "source": ... }` to `claims.json` under `claims`. `source` must be a URL starting with `http`, taken from `research.md`.

## Pitfalls
- If a claim has no URL source in `research.md`, cut it from the draft. Don't send it back for more research just to justify it.
- A factual sentence in `draft.md` that is missing from `claims.json` is flagged by the reviewer. Keep the ledger complete.
- If you were sent back by the reviewer or rejected by a human, the reasons are in your prompt. Fix exactly those.
