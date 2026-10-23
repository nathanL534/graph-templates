import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent, back, check, checks as c, claude, defineGraph, effect, human, lint, resolveStep, runGraph, script, type GraphConfig } from "../src";

let root: string;
const runDir = (key = "t") => join(root, "runs", key);
const run = (g: GraphConfig, key = "t", input?: string) => runGraph(g, key, { root, input, log: () => {} });
const state = (key = "t") => JSON.parse(readFileSync(join(runDir(key), ".graph", "state.json"), "utf8"));
const read = (file: string, key = "t") => readFileSync(join(runDir(key), file), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "graph-test-"));
  delete process.env.GRAPH_AGENT_CMD;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("do → verify → repeat", () => {
  test("a failed attempt is retried with the failures as feedback", async () => {
    const g = defineGraph({
      name: "retry",
      steps: [
        script("work", {
          // Attempt 1 writes nothing; attempt 2 writes the output and records the feedback it saw.
          run: `[ "$GRAPH_ATTEMPT" = 2 ] && cp "$GRAPH_FEEDBACK" out.txt || true`,
          outputs: ["out.txt"],
          retries: 1,
        }),
      ],
    });
    expect(await run(g)).toBe("done");
    expect(read("out.txt")).toContain("missing out.txt");
    expect(state().steps.work.attempts).toBe(2);
  });

  test("exhausted retries block the run", async () => {
    const g = defineGraph({ name: "block", steps: [script("work", { run: "true", outputs: ["never.txt"], retries: 2 })] });
    expect(await run(g)).toBe("blocked");
    expect(state().steps.work).toMatchObject({ status: "blocked", attempts: 3 });
  });

  test("a non-zero script exit fails the step even when its outputs exist", async () => {
    const g = defineGraph({ name: "exit", steps: [script("work", { run: "echo x > out.txt; exit 7", outputs: ["out.txt"] })] });
    expect(await run(g)).toBe("blocked");
    expect(state().steps.work.feedback).toContain("script exited 7");
  });

  test("outputs are cleared before each attempt, so a do-nothing retry fails", async () => {
    const g = defineGraph({
      name: "clear",
      steps: [
        script("work", {
          // Attempt 1 writes a wrong answer; attempt 2 does nothing at all.
          run: `[ "$GRAPH_ATTEMPT" = 1 ] && echo bad > out.txt || true`,
          outputs: ["out.txt"],
          retries: 1,
          checks: [c.matches("out.txt", "good", { id: "says-good" })],
        }),
      ],
    });
    expect(await run(g)).toBe("blocked");
    // The stale "bad" file must not count as attempt 2's work.
    expect(state().steps.work.feedback).toContain("missing out.txt");
    expect(existsSync(join(runDir(), "out.txt"))).toBe(false);
    expect(read(".graph/prev/work/out.txt").trim()).toBe("bad");
  });

  test("a failing check sends its target back with the reviewer's verdict", async () => {
    const g = defineGraph({
      name: "review",
      // The reviewer fails the first draft and passes the second.
      agent: () => ["bash", "-c", `if grep -q v2 draft.txt; then echo "Verdict: PASS" > "$GRAPH_VERDICT"; else printf 'needs a title\\nVerdict: FAIL\\n' > "$GRAPH_VERDICT"; fi`],
      steps: [
        script("draft", { run: `if grep -q "needs a title" "$GRAPH_FEEDBACK"; then echo v2 > draft.txt; else echo v1 > draft.txt; fi`, outputs: ["draft.txt"] }),
        check("review", { of: "draft", reads: ["draft.txt"], rubric: "has a title" }),
      ],
    });
    expect(await run(g)).toBe("done");
    expect(read("draft.txt").trim()).toBe("v2");
    expect(state().reentries).toBe(1);
    // A written FAIL goes back at once; it is not retried.
    expect(state().steps.review.attempts).toBe(1);
  });

  test("'Sent back by' feedback survives the target's own retries", async () => {
    const g = defineGraph({
      name: "keep-feedback",
      agent: () => ["bash", "-c", `if grep -q "Sent back" draft.txt; then echo "Verdict: PASS" > "$GRAPH_VERDICT"; else printf 'say more\\nVerdict: FAIL\\n' > "$GRAPH_VERDICT"; fi`],
      steps: [
        script("draft", {
          // Round 1 writes v1. Once sent back, attempt 1 fails its own check and attempt 2 records the feedback it was shown.
          run: `if grep -q "Sent back by" "$GRAPH_FEEDBACK"; then if [ "$GRAPH_ATTEMPT" = 2 ]; then cp "$GRAPH_FEEDBACK" draft.txt; else echo v2 > draft.txt; fi; else echo v1 > draft.txt; fi`,
          outputs: ["draft.txt"],
          retries: 1,
          checks: [c.matches("draft.txt", "^v1$|Sent back", { id: "v1-or-echoes-feedback" })],
        }),
        check("review", { of: "draft", reads: ["draft.txt"], rubric: "echoes feedback" }),
      ],
    });
    expect(await run(g)).toBe("done");
    const draft = read("draft.txt");
    expect(draft).toContain("Sent back by review");
    expect(draft).toContain("say more");
    expect(draft).toContain("v1-or-echoes-feedback");
    expect(state().steps.draft.attempts).toBe(2);
  });

  test("re-entries are capped by the budget", async () => {
    const g = defineGraph({
      name: "loop",
      budget: { maxReentries: 1 },
      agent: () => ["bash", "-c", `echo "Verdict: FAIL" > "$GRAPH_VERDICT"`],
      steps: [script("draft", { run: "echo x > d.txt", outputs: ["d.txt"] }), check("review", { of: "draft", reads: ["d.txt"], rubric: "-" })],
    });
    expect(await run(g)).toBe("blocked");
    expect(state().reentries).toBe(1);
    expect(state().steps.review.status).toBe("blocked");
  });

  test("a reviewer that crashes is retried, then blocks instead of sending back", async () => {
    const g = defineGraph({
      name: "crash",
      // Even a written FAIL does not count when the reviewer itself failed.
      agent: () => ["bash", "-c", `echo "Verdict: FAIL" > "$GRAPH_VERDICT"; exit 1`],
      steps: [script("draft", { run: "echo x > d.txt", outputs: ["d.txt"] }), check("review", { of: "draft", reads: ["d.txt"], rubric: "-" })],
    });
    expect(await run(g)).toBe("blocked");
    expect(state().reentries).toBe(0);
    expect(state().steps.review).toMatchObject({ status: "blocked", attempts: 2 });
    expect(state().steps.review.feedback).toContain("reviewer exited 1");
    expect(state().steps.draft.status).toBe("passed");
  });

  test("a reviewer that writes no verdict is retried, then blocks", async () => {
    const g = defineGraph({
      name: "no-verdict",
      agent: () => ["bash", "-c", "true"],
      steps: [script("draft", { run: "echo x > d.txt", outputs: ["d.txt"] }), check("review", { of: "draft", reads: ["d.txt"], rubric: "-" })],
    });
    expect(await run(g)).toBe("blocked");
    expect(state().reentries).toBe(0);
    expect(state().steps.review).toMatchObject({ status: "blocked", attempts: 2 });
  });

  test("a reviewer that edits what it reviews fails, its edits are undone, and the run blocks", async () => {
    const g = defineGraph({
      name: "tamper",
      agent: () => ["bash", "-c", `echo fixed > d.txt; echo "Verdict: PASS" > "$GRAPH_VERDICT"`],
      steps: [script("draft", { run: "echo x > d.txt", outputs: ["d.txt"] }), check("review", { of: "draft", reads: ["d.txt"], rubric: "-" })],
    });
    expect(await run(g)).toBe("blocked");
    expect(state().reentries).toBe(0);
    expect(state().steps.review).toMatchObject({ status: "blocked", attempts: 2 });
    expect(state().steps.review.feedback).toContain("reviewer modified the files it was reviewing");
    expect(read("d.txt").trim()).toBe("x");
  });

  test("a spawned step is killed at the budget deadline", async () => {
    const g = defineGraph({
      name: "deadline",
      budget: { minutes: 0.005 },
      steps: [script("slow", { run: "sleep 30; echo x > out.txt", outputs: ["out.txt"] })],
    });
    const started = Date.now();
    const result = await run(g);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(["blocked", "over-budget"]).toContain(result);
    expect(existsSync(join(runDir(), "out.txt"))).toBe(false);
  });
});

describe("resume and staleness", () => {
  const counting = (name: string, out: string) =>
    script(name, { run: `echo run >> ../../${name}.count; echo ${name} > ${out}`, outputs: [out] });
  const count = (name: string) => readFileSync(join(root, `${name}.count`), "utf8").trim().split("\n").length;

  test("fresh steps are skipped; an upstream change re-runs everything downstream", async () => {
    const g = defineGraph({ name: "stale", steps: [counting("a", "a.txt"), counting("b", "b.txt")] });
    expect(await run(g)).toBe("done");
    expect(await run(g)).toBe("done");
    expect([count("a"), count("b")]).toEqual([1, 1]);

    // A changed upstream output means b passed on inputs that no longer exist.
    writeFileSync(join(runDir(), "a.txt"), "edited by hand");
    expect(await run(g)).toBe("done");
    expect([count("a"), count("b")]).toEqual([1, 2]);
  });

  test("optional outputs are hashed and cleared like outputs, but never required", async () => {
    const g = defineGraph({
      name: "optional",
      steps: [script("maybe", { run: "echo a > a.txt", outputs: ["a.txt"], optionalOutputs: ["maybe.txt"] }), counting("b", "b.txt")],
    });
    expect(await run(g)).toBe("done");
    expect(existsSync(join(runDir(), "maybe.txt"))).toBe(false);
    writeFileSync(join(runDir(), "maybe.txt"), "appeared");
    expect(await run(g)).toBe("done");
    expect(count("b")).toBe(2);
  });

  test("input.md is copied in and hashed into every stage", async () => {
    const input = join(root, "request.md");
    writeFileSync(input, "first");
    const g = defineGraph({ name: "input", steps: [counting("a", "a.txt")] });
    expect(await run(g, "t", input)).toBe("done");
    expect(read("input.md")).toBe("first");
    expect(await run(g, "t", input)).toBe("done");
    expect(count("a")).toBe(1);

    writeFileSync(input, "second");
    expect(await run(g, "t", input)).toBe("done");
    expect(read("input.md")).toBe("second");
    expect(count("a")).toBe(2);
  });

  test("a human pause resumes, and approval is revoked when what was approved changes", async () => {
    const g = defineGraph({
      name: "human",
      steps: [script("a", { run: "test -f a.txt || echo one > a.txt", outputs: ["a.txt"] }), human("approve", { instructions: "look" }), counting("b", "b.txt")],
    });
    expect(await run(g)).toBe("waiting");
    writeFileSync(join(runDir(), "APPROVED"), "");
    expect(await run(g)).toBe("done");

    writeFileSync(join(runDir(), "a.txt"), "two");
    expect(await run(g)).toBe("waiting");
    expect(existsSync(join(runDir(), "APPROVED"))).toBe(false);
  });

  test("an APPROVED placed before the pause is stale and gets deleted", async () => {
    const g = defineGraph({
      name: "stale-approval",
      steps: [script("a", { run: "test -f a.txt || echo one > a.txt", outputs: ["a.txt"] }), human("approve", { instructions: "look" })],
    });
    const approved = join(runDir(), "APPROVED");
    mkdirSync(runDir(), { recursive: true });
    writeFileSync(approved, "");
    expect(await run(g)).toBe("waiting");
    expect(existsSync(approved)).toBe(false);
    expect(state().steps.approve.status).toBe("waiting");
  });

  test("an approval written while waiting is void if the inputs changed before the re-run", async () => {
    const g = defineGraph({
      name: "revoke-waiting",
      steps: [script("a", { run: "test -f a.txt || echo one > a.txt", outputs: ["a.txt"] }), human("approve", { instructions: "look" })],
    });
    expect(await run(g)).toBe("waiting");
    writeFileSync(join(runDir(), "a.txt"), "two");
    writeFileSync(join(runDir(), "APPROVED"), "");
    expect(await run(g)).toBe("waiting");
    expect(existsSync(join(runDir(), "APPROVED"))).toBe(false);
    // Approving the version that is actually waiting works.
    writeFileSync(join(runDir(), "APPROVED"), "");
    expect(await run(g)).toBe("done");
  });

  test("REJECTED sends the run back to rejectTo with the reasons, and is ignored without rejectTo", async () => {
    const g = defineGraph({
      name: "reject",
      steps: [
        script("draft", { run: `if grep -q "Rejected by a human" "$GRAPH_FEEDBACK"; then cp "$GRAPH_FEEDBACK" draft.txt; else echo v1 > draft.txt; fi`, outputs: ["draft.txt"] }),
        human("approve", { instructions: "look", rejectTo: "draft" }),
      ],
    });
    expect(await run(g)).toBe("waiting");
    writeFileSync(join(runDir(), "REJECTED"), "too long");
    expect(await run(g)).toBe("waiting");
    expect(state().reentries).toBe(1);
    expect(read("draft.txt")).toContain("Rejected by a human");
    expect(read("draft.txt")).toContain("too long");
    expect(existsSync(join(runDir(), "REJECTED"))).toBe(false);
    writeFileSync(join(runDir(), "APPROVED"), "");
    expect(await run(g)).toBe("done");

    const noReject = defineGraph({ name: "no-reject", steps: [script("a", { run: "echo x > a.txt", outputs: ["a.txt"] }), human("approve", { instructions: "look" })] });
    expect(await run(noReject, "n")).toBe("waiting");
    writeFileSync(join(runDir("n"), "REJECTED"), "no");
    expect(await run(noReject, "n")).toBe("waiting");
    expect(state("n").reentries).toBe(0);
  });
});

describe("contracts", () => {
  test("invariants are checked after every step, scoped to that step's own outputs", async () => {
    const leak = defineGraph({
      name: "inv",
      invariants: [c.noSecrets()],
      steps: [script("leak", { run: `echo 'api_key: "abcdefgh12345"' > out.txt`, outputs: ["out.txt"] })],
    });
    expect(await run(leak)).toBe("blocked");
    expect(state().steps.leak.feedback).toContain("no-secrets");

    // A secret somewhere else in the run folder is not this step's failure.
    const input = join(root, "req.md");
    writeFileSync(input, `password: "hunter2hunter2"`);
    const clean = defineGraph({ name: "inv-scoped", invariants: [c.noSecrets()], steps: [script("clean", { run: "echo ok > out.txt", outputs: ["out.txt"] })] });
    expect(await run(clean, "s", input)).toBe("done");
  });

  test("the goal is checked at the end", async () => {
    const g = defineGraph({ name: "goal", steps: [script("a", { run: "echo a > a.txt", outputs: ["a.txt"] })], goal: [c.fileExists("final.txt")] });
    expect(await run(g)).toBe("goal-failed");
  });

  test("an effect's verify command is run by the runner against the target", async () => {
    const push = effect("push", {
      run: `echo 'echo replayed' > replay.sh; echo '{"fields":[{"field":"x","expected":1,"actual":1}]}' > readback.json`,
      replay: "replay.sh",
      readback: "readback.json",
      verify: "test -f ../../landed.txt",
    });
    const g = defineGraph({ name: "verify", steps: [push] });
    expect(resolveStep(push, g).checks.map((ch) => ch.id)).toContain("verify-target");
    expect(await run(g)).toBe("blocked");
    expect(state().steps.push.feedback).toContain("verify-target");
    writeFileSync(join(root, "landed.txt"), "");
    expect(await run(g, "u")).toBe("done");
  });

  test("claude() spawns headless with acceptEdits unless told otherwise", () => {
    expect(claude()({ prompt: "p" })).toEqual(["claude", "-p", "p", "--permission-mode", "acceptEdits"]);
    expect(claude({ model: "m", extraArgs: ["--x"] })({ prompt: "p", tools: ["Bash", "WebFetch"] })).toEqual([
      "claude", "-p", "p", "--model", "m", "--allowedTools", "Bash,WebFetch", "--x",
    ]);
  });

  test("defaults layer: kind default → graph defaults → step", () => {
    const g = defineGraph({
      name: "layers",
      defaults: { agent: { retries: 5, checks: [c.fileExists("shared.txt", { id: "shared" })] } },
      steps: [],
    });
    const s = resolveStep(
      agent("x", {
        brief: "x.md",
        outputs: ["x.txt"],
        retries: 1,
        skip: ["non-empty:x.txt"],
        checks: [c.matches("x.txt", "ok", { id: "exists:x.txt" })],
        onExhausted: back("earlier"),
      }),
      g,
    );
    expect(s.checks.map((ch) => ch.id)).toEqual(["exists:x.txt", "shared"]);
    expect(s.checks[0]!.kind).toBe("matches"); // replaced by id, not appended
    expect(s.sources).toMatchObject({ "exists:x.txt": "step", shared: "graph", retries: "step", onExhausted: "step" });
    expect(s.retries).toBe(1);

    const plain = resolveStep(agent("y", { brief: "y.md", outputs: ["y.txt"] }), g);
    expect(plain.retries).toBe(5);
    expect(plain.sources.retries).toBe("graph");

    const review = resolveStep(check("r", { of: "y", reads: ["y.txt"], rubric: "-" }), g);
    expect(review.retries).toBe(1);
    expect(review.onExhausted).toEqual({ back: "y" });
    // A human answers once; retries never apply.
    expect(resolveStep(human("h", { instructions: "-", retries: 4 }), g).retries).toBe(0);
  });

  test("lint catches wiring mistakes", () => {
    writeFileSync(join(root, "ok.md"), "");
    const g = defineGraph({
      name: "bad",
      steps: [
        check("early-review", { of: "late", reads: ["late.txt"], rubric: "-" }),
        agent("late", { brief: "missing.md", outputs: ["late.txt"], onExhausted: back("later-still") }),
        script("dup", { run: "true", optionalOutputs: ["late.txt"] }),
        script("later-still", { run: "true", outputs: ["z.txt"] }),
      ],
    });
    const { errors } = lint(g, root);
    const all = errors.join("\n");
    expect(all).toContain(`reviews "late", which is not upstream`);
    expect(all).toContain("brief missing.md not found");
    expect(all).toContain("which runs later");
    expect(all).toContain("late.txt is an output of both");
  });
});
