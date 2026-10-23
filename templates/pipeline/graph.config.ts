import { agent, check, checks as c, claude, defineGraph, effect, human, parallel } from "graph-templates";

// Steps run top to bottom; `parallel(...)` runs its steps at the same time.
// Each kind brings a default contract (`graph plan` prints it). Override per step
// with `checks` / `skip` / `retries` / `onExhausted`, or per kind with `defaults`.
//
// Start a run with the request as input: `graph run <key> --input request.md`.
// The runner copies it to runs/<key>/input.md, which intake reads.

/** A check written in JS, run by bun inside the run folder. Prints its reason to stderr and exits 1 on failure. */
const js = (code: string) => `bun -e '${code.trim()}'`;

export default defineGraph({
  name: "pipeline",
  agent: claude(),
  budget: { minutes: 90, maxReentries: 2 },
  invariants: [c.noSecrets()],

  steps: [
    agent("intake", {
      brief: "nodes/intake.md",
      outputs: ["request.md"],
      checks: [
        c.sections("request.md", ["Goal", "Constraints", "Done When"]),
        c.matches("request.md", "^## Done When[ \\t]*\\r?\\n(?:(?!## ).*\\r?\\n)*?- \\[ \\] \\S", {
          id: "done-is-checklist",
          why: "Done-conditions must be a `- [ ]` checklist inside the Done When section, so the reviewer can tick them.",
        }),
      ],
    }),

    parallel(
      agent("research", {
        brief: "nodes/research.md",
        outputs: ["research.md"],
        tools: ["WebSearch", "WebFetch"],
        checks: [
          c.sections("research.md", ["Sources", "Findings", "Gaps"]),
          c.command(
            js(`
              const lines = (await Bun.file("research.md").text()).split(/\\r?\\n/);
              const start = lines.findIndex((l) => l.trim() === "## Findings");
              const body = start === -1 ? [] : lines.slice(start + 1);
              const end = body.findIndex((l) => l.startsWith("## "));
              const bullets = (end === -1 ? body : body.slice(0, end)).filter((l) => new RegExp("^[ \\\\t]*[-*] ").test(l));
              if (bullets.length === 0) { console.error("Findings has no bullets"); process.exit(1); }
              const bad = bullets.filter((l) => !new RegExp("https?://[^ )]+").test(l));
              if (bad.length) { console.error("Findings bullets without a URL: " + JSON.stringify(bad)); process.exit(1); }
            `),
            { id: "findings-have-urls", why: "A finding with no URL on its own bullet can't be re-checked by the reviewer." },
          ),
        ],
      }),
      agent("setup", {
        brief: "nodes/setup.md",
        optionalOutputs: ["setup.json", "no-setup-needed.flag"],
        retries: 0,
        onExhausted: "block",
        checks: [
          c.anyOf(
            [
              { kind: "file_exists", path: "no-setup-needed.flag" },
              { kind: "json", path: "setup.json", required: ["ready", "prepared"], equals: { ready: true } },
            ],
            { id: "ready-or-skipped", why: "A conditional step still has to say which branch it took." },
          ),
          c.command("! { test -f setup.json && test -f no-setup-needed.flag; }", {
            id: "one-branch",
            why: "setup.json and no-setup-needed.flag contradict each other; write exactly one.",
          }),
        ],
      }),
    ),

    agent("draft", {
      brief: "nodes/draft.md",
      outputs: ["draft.md", "claims.json"],
      checks: [
        c.command(
          js(`
            const claims = (await Bun.file("claims.json").json()).claims;
            if (!Array.isArray(claims) || claims.length === 0) { console.error("claims.json needs a non-empty claims[]"); process.exit(1); }
            const ok = (x) => x && typeof x.text === "string" && x.text.trim() && typeof x.source === "string" && new RegExp("^https?://").test(x.source);
            const bad = claims.filter((x) => !ok(x));
            if (bad.length) { console.error("claims without text or an http(s) source: " + JSON.stringify(bad)); process.exit(1); }
          `),
          { id: "every-claim-sourced", why: "A claim without a URL source is the failure this graph exists to stop." },
        ),
      ],
    }),

    // do → verify → repeat: a FAIL here sends draft back with the verdict as feedback.
    check("review", {
      of: "draft",
      reads: ["request.md", "research.md", "draft.md", "claims.json"],
      rubric: [
        "For each entry in claims.json, find it in research.md. Flag any claim that is UNSUPPORTED or CONTRADICTED.",
        "For each factual sentence in draft.md, find it in claims.json. Flag any sentence that is missing from the ledger.",
        "Tick each `Done When` item in request.md against draft.md. Flag any that is not met.",
        "PASS only if there are no flags.",
      ].join("\n"),
    }),

    // A human signs off on the reviewed draft before anything touches the outside world.
    human("approve", {
      instructions: "Read draft.md in the run folder. To send it back, write your reasons to REJECTED instead of touching APPROVED.",
      rejectTo: "draft",
    }),

    effect("execute", { brief: "nodes/execute.md", replay: "replay.sh", readback: "readback.json", tools: ["Bash"] }),

    agent("log", {
      brief: "nodes/log.md",
      outputs: ["log.json"],
      retries: 1,
      checks: [
        c.command(
          js(`
            const l = await Bun.file("log.json").json();
            const w = l.written, r = l.readBack ?? {};
            if (!w || typeof w !== "object" || Array.isArray(w) || Object.keys(w).length === 0) { console.error("written must be a non-empty object"); process.exit(1); }
            const norm = (v) => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
            const diff = Object.keys(w).filter((k) => norm(w[k]) !== norm(r[k])).map((k) => k + ": wrote " + norm(w[k]) + ", read back " + norm(r[k]));
            if (diff.length) { console.error("readBack differs from written: " + diff.join("; ")); process.exit(1); }
          `),
          { id: "readback-equals-write", why: "Trackers silently truncate, reorder, or drop writes; every written key must read back equal." },
        ),
      ],
    }),
  ],

  goal: [
    c.matches(".graph/verdicts/review.md", "Verdict: PASS\\s*$", { id: "review-passed", flags: "", why: "The final draft must be the reviewed one." }),
    c.fileExists("APPROVED", { id: "human-approved", why: "Nothing is final without a human." }),
  ],
});
