# Setup (conditional)

> Contract: the `setup` step in `graph.config.ts` (`graph plan` shows the resolved checks). Runs in parallel with research.

## Purpose
Get the execution target ready: accounts, environments, credentials. Most runs need nothing, and then this node passes straight away.

## Steps
1. Decide from `request.md` whether execution needs anything prepared.
2. If not, write an empty `no-setup-needed.flag`.
3. If so, prepare it, then write `setup.json`: `{ "ready": true, "prepared": [...] }`. Put secrets in a gitignored env file, never in run artifacts.

Write exactly one of the two files. Both present fails the `one-branch` check; neither fails `ready-or-skipped`.

## Pitfalls
- Anything that needs a human (an identity check, a payment, a captcha) is a `block`, not a retry.
