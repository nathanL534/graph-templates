// Runs a graph end to end: for each stage, do the work, verify it against the
// resolved contract, retry with the failures as feedback, and move on only on PASS.
// State lives in runs/<key>/.graph/state.json, so a crash or a human pause resumes
// where it stopped.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evaluate, VERDICT_FAIL, type GateCheck } from "./checks";
import { claude, type GraphConfig } from "./dsl";
import { resolveStages, type Exec, type ResolvedStep } from "./contracts";

type StepState = {
  status: "passed" | "failed" | "blocked" | "waiting";
  attempts: number;
  inputsHash: string;
  feedback?: string;
  at: string;
};

export type RunState = {
  graph: string;
  startedAt: string;
  reentries: number;
  status?: RunResult;
  steps: Record<string, StepState>;
};

export type RunResult = "done" | "blocked" | "waiting" | "goal-failed" | "over-budget";
type Outcome = "passed" | "blocked" | "waiting" | { back: string; from: string; feedback: string };

export type RunOptions = {
  /** Project directory: briefs resolve against it. */
  root: string;
  runsDir?: string;
  /** Copied to runs/<key>/input.md: the raw request the first step works from. */
  input?: string;
  log?: (line: string) => void;
};

export const INPUT = "input.md";
const REJECTED = "REJECTED";

export const statePath = (runDir: string) => join(runDir, ".graph", "state.json");

export function readState(runDir: string): RunState | null {
  const p = statePath(runDir);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export async function runGraph(graph: GraphConfig, key: string, opts: RunOptions): Promise<RunResult> {
  const dir = join(opts.runsDir ?? join(opts.root, "runs"), key);
  const meta = join(dir, ".graph");
  mkdirSync(join(meta, "logs"), { recursive: true });
  mkdirSync(join(meta, "verdicts"), { recursive: true });
  if (opts.input) cpSync(opts.input, join(dir, INPUT));

  const log = opts.log ?? console.log;
  const stages = resolveStages(graph);
  const maxReentries = graph.budget?.maxReentries ?? 2;
  const deadline = graph.budget?.minutes ? Date.now() + graph.budget.minutes * 60_000 : Infinity;
  const runner = graph.agent ?? claude();

  const state: RunState = readState(dir) ?? { graph: graph.name, startedAt: new Date().toISOString(), reentries: 0, steps: {} };
  const save = () => writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
  const set = (name: string, patch: Partial<StepState>) => {
    state.steps[name] = { ...(state.steps[name] ?? { status: "failed", attempts: 0, inputsHash: "" }), ...patch, at: new Date().toISOString() };
    save();
  };
  const finish = (result: RunResult) => {
    state.status = result;
    save();
    return result;
  };

  const hashFiles = (paths: string[]) => {
    const h = createHash("sha256");
    for (const p of paths) {
      const f = join(dir, p);
      h.update(p).update("\0").update(existsSync(f) ? readFileSync(f) : "∅").update("\0");
    }
    return h.digest("hex").slice(0, 16);
  };
  const produced = (s: ResolvedStep) => [...s.outputs, ...s.optionalOutputs];
  // A step's inputs are the run input plus everything produced before its stage. Any change makes it stale.
  const inputsHash = (stageIndex: number) => hashFiles([INPUT, ...stages.slice(0, stageIndex).flat().flatMap(produced)]);

  /** Forget a step so it runs fresh. An approval never survives a change to what was approved. */
  const reset = (s: ResolvedStep) => {
    delete state.steps[s.name];
    if (s.exec.type === "human") for (const f of [s.exec.file, REJECTED]) rmSync(join(dir, f), { force: true });
  };

  /** Move last attempt's outputs aside, so an attempt that does nothing can't pass on stale files. */
  const clearOutputs = (s: ResolvedStep) => {
    const prev = join(meta, "prev", s.name);
    rmSync(prev, { recursive: true, force: true });
    for (const o of produced(s)) {
      const f = join(dir, o);
      if (!existsSync(f)) continue;
      mkdirSync(dirname(join(prev, o)), { recursive: true });
      renameSync(f, join(prev, o));
    }
  };

  const agentCommand = (prompt: string, model?: string, tools?: string[]) =>
    process.env.GRAPH_AGENT_CMD ? [...process.env.GRAPH_AGENT_CMD.split(" "), prompt] : runner({ prompt, model, tools });

  /** Runs a command in the run folder, logs its output, and returns its exit code (non-zero if killed at the deadline). */
  async function spawn(cmd: string[], env: Record<string, string>, logFile: string): Promise<number> {
    const proc = Bun.spawn(cmd, { cwd: dir, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    // A hung agent must not outlive the budget.
    let killed = false;
    const timer = Number.isFinite(deadline)
      ? setTimeout(() => {
          killed = true;
          proc.kill();
        }, Math.max(0, deadline - Date.now()))
      : undefined;
    // Drain both pipes while it runs. A grandchild it leaves behind may keep a pipe open, so stop reading once it has exited.
    const drain = (stream: ReadableStream<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      const done = (async () => {
        for await (const chunk of stream) chunks.push(chunk);
      })();
      return { done, text: () => Buffer.concat(chunks).toString("utf8") };
    };
    const out = drain(proc.stdout);
    const err = drain(proc.stderr);
    const code = await proc.exited;
    clearTimeout(timer);
    await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(200)]);
    const stderr = err.text() + (killed ? "\n--- killed: budget deadline reached ---" : "");
    writeFileSync(logFile, out.text() + (stderr.trim() ? `\n--- stderr ---\n${stderr}` : ""));
    return killed && code === 0 ? 1 : code;
  }

  function agentPrompt(s: ResolvedStep, exec: Extract<Exec, { type: "agent" }>, attempt: number, feedback?: string): string {
    const brief = readFileSync(join(opts.root, exec.brief), "utf8");
    return [
      `You are running step "${s.name}" (attempt ${attempt}) of the "${graph.name}" graph.`,
      `Work only inside the current directory; it holds this run's artifacts.`,
      ...(existsSync(join(dir, INPUT)) ? [`The request for this run is in ${INPUT}.`] : []),
      ...(existsSync(join(meta, "prev", s.name)) ? [`Your previous attempt's files are in .graph/prev/${s.name}/ (read-only reference).`] : []),
      ``,
      `## Instructions`,
      brief,
      ``,
      `## Produce`,
      ...s.outputs.map((o) => `- ${o}`),
      ``,
      `## Your work is checked on`,
      ...s.checks.map((ch) => `- ${ch.id}: ${ch.why}`),
      ...(feedback ? [``, `## Your previous attempt failed`, feedback, ``, `Fix these and try again.`] : []),
    ].join("\n");
  }

  function reviewPrompt(s: ResolvedStep, exec: Extract<Exec, { type: "review" }>): string {
    return [
      `You are an independent reviewer for step "${exec.of}" of the "${graph.name}" graph. You did not produce this work.`,
      `Read: ${exec.reads.join(", ")}. Do not modify any file except ${exec.verdict}.`,
      ``,
      `## Rubric`,
      exec.rubric,
      ``,
      `Write your findings to ${exec.verdict}: one line per problem, specific enough to fix.`,
      `Its last line must be exactly "Verdict: PASS" or "Verdict: FAIL".`,
    ].join("\n");
  }

  /** Runs the step's work. Returns the failures it produced (empty = executor succeeded), "waiting", or a rejection. */
  async function work(s: ResolvedStep, attempt: number, hash: string, feedback?: string): Promise<string[] | "waiting" | { rejected: string }> {
    const logFile = join(meta, "logs", `${s.name}.${attempt}.log`);
    const feedbackFile = join(meta, `${s.name}.feedback.txt`);
    writeFileSync(feedbackFile, feedback ?? "");
    const env = {
      GRAPH_ROOT: opts.root,
      GRAPH_KEY: key,
      GRAPH_STEP: s.name,
      GRAPH_ATTEMPT: String(attempt),
      GRAPH_FEEDBACK: feedbackFile,
    };

    switch (s.exec.type) {
      case "human": {
        // Only an answer written while this exact version was waiting counts.
        const prev = state.steps[s.name];
        const asked = prev?.status === "waiting" && prev.inputsHash === hash;
        if (asked && existsSync(join(dir, REJECTED)) && s.exec.rejectTo) return { rejected: readFileSync(join(dir, REJECTED), "utf8") };
        if (asked && existsSync(join(dir, s.exec.file))) return [];
        if (!asked) for (const f of [s.exec.file, REJECTED]) rmSync(join(dir, f), { force: true });
        log(`  ⏸  waiting on a human: ${s.exec.instructions}`);
        log(`     approve: touch ${join(dir, s.exec.file)}`);
        if (s.exec.rejectTo) log(`     reject:  write reasons to ${join(dir, REJECTED)}`);
        log(`     then re-run`);
        return "waiting";
      }

      case "script": {
        const code = await spawn(["bash", "-c", s.exec.run], env, logFile);
        return code === 0 ? [] : [`script exited ${code} (log: ${logFile})`];
      }

      case "agent": {
        const code = await spawn(agentCommand(agentPrompt(s, s.exec, attempt, feedback), s.exec.model, s.exec.tools), env, logFile);
        return code === 0 ? [] : [`agent exited ${code} (log: ${logFile})`];
      }

      case "review": {
        const verdict = join(dir, s.exec.verdict);
        mkdirSync(dirname(verdict), { recursive: true });
        rmSync(verdict, { force: true });
        // Snapshot what is under review, so a reviewer that edits it is caught and its edits undone before any retry.
        const reads = s.exec.reads.map((p) => join(dir, p));
        const snapshot = reads.map((f) => (existsSync(f) ? readFileSync(f) : null));
        const before = hashFiles(s.exec.reads);
        const code = await spawn(agentCommand(reviewPrompt(s, s.exec), s.exec.model, s.exec.tools), { ...env, GRAPH_VERDICT: verdict }, logFile);
        const failures = code === 0 ? [] : [`reviewer exited ${code} (log: ${logFile})`];
        if (hashFiles(s.exec.reads) !== before) {
          reads.forEach((f, i) => (snapshot[i] === null ? rmSync(f, { force: true }) : writeFileSync(f, snapshot[i]!)));
          failures.push("reviewer modified the files it was reviewing (restored)");
        }
        return failures;
      }
    }
  }

  const failuresOf = (list: GateCheck[], scope?: string[]) =>
    list.flatMap((ch) => {
      const reason = evaluate(ch, dir, scope);
      return reason ? [`✗ ${ch.id}: ${reason}\n    why: ${ch.why}`] : [];
    });

  async function runStep(s: ResolvedStep, stageIndex: number): Promise<Outcome> {
    const hash = inputsHash(stageIndex);
    const prev = state.steps[s.name];

    if (prev?.status === "passed" && prev.inputsHash === hash) {
      log(`✓ ${s.name}  (fresh, skipped)`);
      return "passed";
    }
    // Passed or waiting on inputs that have since changed: start over (and revoke any approval).
    if ((prev?.status === "passed" || prev?.status === "waiting") && prev.inputsHash !== hash) {
      if (prev.status === "passed") log(`↻ ${s.name}  inputs changed since it passed; re-running`);
      reset(s);
    }

    // Feedback from a step that sent this one back survives this step's own retries.
    const sentBack = state.steps[s.name]?.feedback?.startsWith("Sent back by") ? state.steps[s.name]!.feedback : undefined;
    let feedback = state.steps[s.name]?.feedback;
    for (let attempt = 1; attempt <= s.retries + 1; attempt++) {
      log(`▶ ${s.name}  [${s.kind}] attempt ${attempt}/${s.retries + 1}`);
      if (s.exec.type !== "human") clearOutputs(s);
      const done = await work(s, attempt, hash, feedback);
      if (done === "waiting") {
        set(s.name, { status: "waiting", attempts: 0, inputsHash: hash });
        return "waiting";
      }
      if (!Array.isArray(done)) {
        log(`✗ ${s.name}: rejected by a human`);
        return { back: (s.exec as { rejectTo: string }).rejectTo, from: s.name, feedback: `Rejected by a human:\n${done.rejected}` };
      }

      const failures = [...done, ...failuresOf(s.checks), ...failuresOf(graph.invariants ?? [], produced(s))];
      if (failures.length === 0) {
        set(s.name, { status: "passed", attempts: attempt, inputsHash: hash, feedback: undefined });
        log(`✓ ${s.name}`);
        return "passed";
      }

      feedback = [sentBack, failures.join("\n")].filter(Boolean).join("\n\n");
      set(s.name, { status: "failed", attempts: attempt, inputsHash: hash, feedback });
      log(failures.map((f) => `  ${f}`).join("\n"));

      if (s.exec.type === "review") {
        const verdict = join(dir, s.exec.verdict);
        const text = existsSync(verdict) ? readFileSync(verdict, "utf8") : "";
        // A written FAIL is a judgment on the work: send it back now. Anything else (crash, no verdict, tampering) is the reviewer's fault: retry it.
        if (done.length === 0 && VERDICT_FAIL.test(text)) {
          if (typeof s.onExhausted === "object") return { back: s.onExhausted.back, from: s.name, feedback: `Reviewer's verdict:\n${text}` };
          break;
        }
      }
    }

    if (typeof s.onExhausted === "object" && s.exec.type !== "review") return { back: s.onExhausted.back, from: s.name, feedback: feedback ?? "" };
    set(s.name, { status: "blocked" });
    log(`■ ${s.name} blocked after its attempts. Fix the cause, then re-run.`);
    return "blocked";
  }

  let i = 0;
  while (i < stages.length) {
    if (Date.now() > deadline) {
      log(`■ budget exhausted (${graph.budget?.minutes} min)`);
      return finish("over-budget");
    }

    const outcomes = await Promise.all(stages[i]!.map((s) => runStep(s, i)));

    const back = outcomes.find((o): o is Extract<Outcome, object> => typeof o === "object");
    if (back) {
      if (state.reentries >= maxReentries) {
        set(back.from, { status: "blocked" });
        log(`■ ${back.from} wants to re-enter ${back.back}, but the re-entry budget (${maxReentries}) is spent.`);
        return finish("blocked");
      }
      const target = stages.findIndex((st) => st.some((s) => s.name === back.back));
      state.reentries++;
      for (const s of stages.slice(target).flat()) reset(s);
      set(back.back, { status: "failed", attempts: 0, inputsHash: "", feedback: `Sent back by ${back.from}:\n${back.feedback}` });
      log(`↩ ${back.from} → re-entering ${back.back} (${state.reentries}/${maxReentries})`);
      i = target;
      continue;
    }
    if (outcomes.includes("blocked")) return finish("blocked");
    if (outcomes.includes("waiting")) return finish("waiting");
    i++;
  }

  const goalFailures = failuresOf(graph.goal ?? []);
  if (goalFailures.length) {
    log(`■ every step passed but the goal did not:\n${goalFailures.map((f) => `  ${f}`).join("\n")}`);
    return finish("goal-failed");
  }
  log(`● done: ${graph.name} / ${key}`);
  return finish("done");
}
