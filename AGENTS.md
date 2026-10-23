# graph-templates: agent instructions

The package is `src/` (CLI, runner, default contracts, checks). Templates live in `templates/<name>/`, and the Claude Code skill in `skill/SKILL.md`.

- Before committing: `bun test && bun run typecheck && bun run demo`. All three must pass.
- A change to the runner or the default contracts needs a test in `test/` that fails without it.
- No personal data, credentials, or private-project specifics in templates. `runs/` is never committed.
- Keep the runtime zero-dependency: Bun plus the standard library.
- When you change a kind's default contract, update the tables in README.md and skill/SKILL.md.
