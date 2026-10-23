import { check, checks as c, claude, defineGraph, parallel, script } from "graph-templates";

// graph-templates verifies itself with its own runner. Run from this folder:
//   graph run <key>      (artifacts in verify/runs/<key>/, gitignored)
// Scripts run inside the run folder; the repo is "$GRAPH_ROOT/..".
const repo = `"$GRAPH_ROOT/.."`;

export default defineGraph({
  name: "verify-graph-templates",
  // The docs reviewer only reads files and writes its verdict.
  agent: claude({ extraArgs: ["--permission-mode", "acceptEdits", "--allowedTools", "Read,Write,Glob,Grep"] }),
  budget: { minutes: 30, maxReentries: 0 },

  steps: [
    parallel(
      script("typecheck", {
        run: `cd ${repo} && bun run typecheck > "$OLDPWD/typecheck.log" 2>&1`,
        outputs: ["typecheck.log"],
      }),
      script("test", {
        run: `cd ${repo} && bun test > "$OLDPWD/test.log" 2>&1`,
        outputs: ["test.log"],
        checks: [c.matches("test.log", "^ 0 fail$", { id: "zero-failures", why: "Exit 0 alone could hide skipped files." })],
      }),
      script("demo", {
        run: `cd ${repo} && bun run demo > "$OLDPWD/demo.log" 2>&1`,
        outputs: ["demo.log"],
        checks: [c.matches("demo.log", "^pipeline / demo: done", { id: "demo-done", why: "The demo must reach done, not just exit." })],
      }),
    ),

    script("init-smoke", {
      // What a stranger runs: scaffold, install, plan, demo, and runs/ stays out of git.
      run: [
        `set -e; d=$(mktemp -d)/proj`,
        `bun ${repo}/src/cli.ts init "$d" > smoke.log`,
        `(cd "$d" && bun install && bun run plan && bun run demo && git init -q && git add -A && echo "staged-runs=$(git status --short | grep -cE 'runs/|tracker\\.jsonl' || true)") >> smoke.log 2>&1`,
        `rm -rf "$(dirname "$d")"`,
      ].join("\n"),
      outputs: ["smoke.log"],
      checks: [
        c.matches("smoke.log", "^ok: \\d+ steps", { id: "plan-ok", why: "A fresh scaffold must lint clean." }),
        c.matches("smoke.log", "^staged-runs=0$", { id: "runs-ignored", why: "Run data must never be committable." }),
      ],
    }),

    script("privacy", {
      // Generic patterns live here; machine-specific names go in verify/private-patterns.txt (gitignored, one regex per line).
      run: [
        `pats='/Users/|/home/[a-z]|/private/tmp|@gmail|[a-z0-9._%+-]+@[a-z0-9.-]+\\.(com|edu|org|io|dev)|resume\\.(tex|pdf|docx)|sk-[A-Za-z0-9]{20}'`,
        `[ -f "$GRAPH_ROOT/private-patterns.txt" ] && pats="$pats|$(grep -v '^#' "$GRAPH_ROOT/private-patterns.txt" | paste -sd'|' -)"`,
        `cd ${repo} && git ls-files -co --exclude-standard | grep -vE '^(LICENSE|verify/graph.config.ts)$' | xargs grep -nIiE "$pats" > "$OLDPWD/privacy.log" || true`,
      ].join("\n"),
      outputs: ["privacy.log"],
      skip: ["exists:privacy.log"],
      checks: [
        c.fileExists("privacy.log", { id: "scan-ran", why: "The scan must have produced its report." }),
        c.matches("privacy.log", "^$", { id: "no-private-strings", flags: "", why: "Personal or private-project strings found; see privacy.log." }),
      ],
    }),

    script("snapshot", {
      run: `mkdir -p docs && cp ${repo}/README.md ${repo}/skill/SKILL.md docs/ && cp ${repo}/src/dsl.ts ${repo}/src/contracts.ts ${repo}/src/checks.ts ${repo}/src/runner.ts ${repo}/src/cli.ts docs/ && cp "$GRAPH_ROOT/../templates/pipeline/graph.config.ts" docs/pipeline.config.ts`,
      outputs: ["docs/README.md", "docs/SKILL.md", "docs/dsl.ts", "docs/contracts.ts", "docs/checks.ts", "docs/runner.ts", "docs/cli.ts", "docs/pipeline.config.ts"],
    }),

    check("docs-review", {
      of: "snapshot",
      reads: ["docs/README.md", "docs/SKILL.md", "docs/dsl.ts", "docs/contracts.ts", "docs/checks.ts", "docs/runner.ts", "docs/cli.ts", "docs/pipeline.config.ts"],
      rubric: [
        "Compare README.md and SKILL.md against the code in dsl.ts, contracts.ts, checks.ts, runner.ts and cli.ts.",
        "Flag every statement in the docs that the code contradicts: default retries, default checks and their ids, onExhausted, CLI commands, flags and exit codes, builder option names, environment variables, and what the runner does between steps (output clearing, staleness hashing, human approval and rejection, reviewer send-back vs retry, budget).",
        "Flag any doc example that would not type-check against dsl.ts (missing required fields, missing imports, unknown options).",
        "Flag any README description of the pipeline template that pipeline.config.ts contradicts (step order, which steps have tools or rejectTo).",
        "PASS only if you find no contradictions. Minor wording issues are not failures.",
      ].join("\n"),
      // Re-running a deterministic copy can't fix a docs bug: block for a human instead of sending it back.
      onExhausted: "block",
    }),
  ],

  goal: [c.matches(".graph/verdicts/docs-review.md", "Verdict: PASS\\s*$", { id: "docs-match-code", flags: "", why: "Shipped docs must describe the shipped code." })],
});
