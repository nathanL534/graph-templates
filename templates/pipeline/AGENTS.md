# Agent instructions

This project is a graph built with `graph-templates`. Read `README.md`, then `graph.config.ts`.

- Run with `graph run <key> --input <request file>`. A step is done only when the runner prints ✓. A run is done only when `graph status <key>` says `done`.
- Never write `runs/<key>/APPROVED` or `runs/<key>/REJECTED`. Only a human does.
- To change what "done" means for a step, edit its `checks` in `graph.config.ts`, then run `graph plan`.
- Test config changes offline first: `GRAPH_AGENT_CMD="bash $PWD/examples/fake-agent.sh" graph run test --input examples/demo/input.md`.
