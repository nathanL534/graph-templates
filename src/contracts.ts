// Default contract per node kind, and the layering that resolves a step's final
// contract: kind default -> graph `defaults[kind]` -> the step's own overrides.

import { checks as c, verdictPath, type GateCheck } from "./checks";
import type { ContractOverride, GraphConfig, Kind, OnExhausted, Parallel, Step } from "./dsl";

export type Exec =
  | { type: "agent"; brief: string; model?: string; tools?: string[] }
  | { type: "script"; run: string }
  | { type: "review"; of: string; rubric: string; reads: string[]; verdict: string; model?: string; tools?: string[] }
  | { type: "human"; instructions: string; file: string; rejectTo?: string };

export type Source = "default" | "graph" | "step";

export type ResolvedStep = {
  name: string;
  kind: Kind;
  exec: Exec;
  outputs: string[];
  optionalOutputs: string[];
  checks: GateCheck[];
  retries: number;
  onExhausted: OnExhausted;
  /** Where each check id and setting came from, for `graph plan`. */
  sources: Record<string, Source>;
};

const unique = (xs: string[]) => [...new Set(xs)];

function defaults(step: Step): Omit<ResolvedStep, "sources"> {
  const { name } = step;
  switch (step.kind) {
    case "agent": {
      const outputs = step.opts.outputs ?? [];
      return {
        name,
        kind: "agent",
        exec: { type: "agent", brief: step.opts.brief, model: step.opts.model, tools: step.opts.tools },
        outputs,
        optionalOutputs: step.opts.optionalOutputs ?? [],
        checks: outputs.flatMap((o) => [c.fileExists(o), c.nonEmpty(o)]),
        retries: 2,
        onExhausted: "block",
      };
    }
    case "script": {
      const outputs = step.opts.outputs ?? [];
      return {
        name,
        kind: "script",
        exec: { type: "script", run: step.opts.run },
        outputs,
        optionalOutputs: step.opts.optionalOutputs ?? [],
        // The runner also fails the step when the script exits non-zero.
        checks: outputs.map((o) => c.fileExists(o)),
        // Deterministic work fails the same way twice; retrying only burns time.
        retries: 0,
        onExhausted: "block",
      };
    }
    case "effect": {
      const { replay, readback } = step.opts;
      const outputs = unique([...(step.opts.outputs ?? []), replay, readback]);
      return {
        name,
        kind: "effect",
        exec:
          "run" in step.opts
            ? { type: "script", run: step.opts.run }
            : { type: "agent", brief: step.opts.brief, model: step.opts.model, tools: step.opts.tools },
        outputs,
        optionalOutputs: [],
        checks: [
          ...outputs.map((o) => c.fileExists(o)),
          c.nonEmpty(replay, { id: "replay-non-empty", why: "An empty replay script means no actions were recorded." }),
          c.command(`bash -n ${replay}`, {
            id: "replay-parses",
            why: "If the target resets mid-run, replaying the script beats redoing the step.",
          }),
          c.command(
            `bun -e 'const r=(await Bun.file("${readback}").json()).fields; process.exit(Array.isArray(r) && r.length>0 && r.every(f=>JSON.stringify(f.expected)===JSON.stringify(f.actual))?0:1)'`,
            {
              id: "readback-matches",
              why: `An action is done when reading it back says so. ${readback} needs fields[] of {field, expected, actual}, all equal.`,
            },
          ),
          ...(step.opts.verify
            ? [c.command(step.opts.verify, { id: "verify-target", why: "The runner reads the result back from the target itself, not from the agent's notes." })]
            : []),
        ],
        // Side effects are not blindly repeatable; one retry, then a human looks.
        retries: 1,
        onExhausted: "block",
      };
    }
    case "check": {
      const verdict = verdictPath(name);
      return {
        name,
        kind: "check",
        exec: { type: "review", of: step.opts.of, rubric: step.opts.rubric, reads: step.opts.reads, verdict, model: step.opts.model, tools: step.opts.tools },
        outputs: [],
        optionalOutputs: [],
        checks: [c.verdictPassed(name, { id: "verdict-pass" })],
        // A written FAIL goes straight back to `of`; retries only cover a reviewer that crashed or wrote no verdict.
        retries: 1,
        onExhausted: { back: step.opts.of },
      };
    }
    case "human": {
      const file = step.opts.file ?? "APPROVED";
      return {
        name,
        kind: "human",
        exec: { type: "human", instructions: step.opts.instructions, file, rejectTo: step.opts.rejectTo },
        outputs: [file],
        optionalOutputs: [],
        checks: [c.fileExists(file, { id: "approved", why: "Only a human writes the approval file." })],
        retries: 0,
        onExhausted: "block",
      };
    }
  }
}

function layer(step: ResolvedStep, o: ContractOverride | undefined, source: Source): void {
  if (!o) return;
  if (o.skip?.length) step.checks = step.checks.filter((ch) => !o.skip!.includes(ch.id));
  for (const ch of o.checks ?? []) {
    const i = step.checks.findIndex((x) => x.id === ch.id);
    if (i === -1) step.checks.push(ch);
    else step.checks[i] = ch;
    step.sources[ch.id] = source;
  }
  if (o.retries !== undefined) {
    step.retries = o.retries;
    step.sources.retries = source;
  }
  if (o.onExhausted !== undefined) {
    step.onExhausted = o.onExhausted;
    step.sources.onExhausted = source;
  }
}

export function resolveStep(step: Step, graph: GraphConfig): ResolvedStep {
  const base = defaults(step);
  const resolved: ResolvedStep = { ...base, sources: {} };
  for (const ch of base.checks) resolved.sources[ch.id] = "default";
  resolved.sources.retries = "default";
  resolved.sources.onExhausted = "default";
  layer(resolved, graph.defaults?.[step.kind], "graph");
  layer(resolved, step.opts, "step");
  // A human answers once; re-checking an existing file can't change the answer.
  if (step.kind === "human") resolved.retries = 0;
  return resolved;
}

/** Stages in order; each stage is one step or a parallel group. */
export function resolveStages(graph: GraphConfig): ResolvedStep[][] {
  return graph.steps.map((s: Step | Parallel) =>
    s.kind === "parallel" ? s.steps.map((p) => resolveStep(p, graph)) : [resolveStep(s, graph)],
  );
}
