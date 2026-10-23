# Research

> Contract: the `research` step in `graph.config.ts` (`graph plan` shows the resolved checks). Has WebSearch and WebFetch.

## Purpose
Collect the facts the draft will rely on, each one tied to a URL.

## Steps
1. Read `request.md`.
2. Search, fetch, and read primary sources. Prefer the source itself over summaries of it.
3. Write `research.md` with three sections:
   - `## Sources`: one bullet per URL you used.
   - `## Findings`: one bullet per fact, and the URL it comes from on that same bullet, e.g. `- Bun ships a test runner (https://bun.sh/docs).`
   - `## Gaps`: what you could not establish.

## Pitfalls
- A Findings bullet without a URL fails the `findings-have-urls` check. Put the URL on the bullet, not only under Sources.
- Never fill a gap with a plausible guess. Write it under Gaps; the draft node decides what to do about it.
