// The config surface: node kinds you stitch together in graph.config.ts.
// Each kind comes with a default contract (see contracts.ts); every step can
// override it, and the graph can override it per kind.

import type { GateCheck } from "./checks";

export type Kind = "agent" | "script" | "effect" | "check" | "human";
export type OnExhausted = "block" | { back: string };

/** Layered on top of a kind's default contract. */
export type ContractOverride = {
  /** Added to the defaults. A check whose id matches a default replaces it. */
  checks?: GateCheck[];
  /** Ids of default checks to drop. */
  skip?: string[];
  retries?: number;
  onExhausted?: OnExhausted;
};

type AgentWork = { brief: string; model?: string; tools?: string[] };
type ScriptWork = { run: string };

/** optionalOutputs: files a step may or may not write (e.g. one branch of two). Hashed and cleared like outputs, never required. */
type Produces = { outputs?: string[]; optionalOutputs?: string[] };

export type AgentOpts = ContractOverride & AgentWork & Produces;
export type ScriptOpts = ContractOverride & ScriptWork & Produces;
export type EffectOpts = ContractOverride &
  (AgentWork | ScriptWork) & {
    outputs?: string[];
    replay: string;
    readback: string;
    /** A command the runner runs itself to read the result back from the real target. */
    verify?: string;
  };
export type CheckOpts = ContractOverride & { of: string; rubric: string; reads: string[]; model?: string; tools?: string[] };
export type HumanOpts = ContractOverride & {
  instructions: string;
  file?: string;
  /** If the human writes REJECTED (with reasons) instead, send this step back with them. */
  rejectTo?: string;
};

export type Step =
  | { kind: "agent"; name: string; opts: AgentOpts }
  | { kind: "script"; name: string; opts: ScriptOpts }
  | { kind: "effect"; name: string; opts: EffectOpts }
  | { kind: "check"; name: string; opts: CheckOpts }
  | { kind: "human"; name: string; opts: HumanOpts };

export type Parallel = { kind: "parallel"; steps: Step[] };

/** An LLM does the work, following a markdown brief. */
export const agent = (name: string, opts: AgentOpts): Step => ({ kind: "agent", name, opts });
/** Deterministic code does the work. */
export const script = (name: string, opts: ScriptOpts): Step => ({ kind: "script", name, opts });
/** Work that changes the outside world: must leave a replay script and a read-back. */
export const effect = (name: string, opts: EffectOpts): Step => ({ kind: "effect", name, opts });
/** A different agent reviews an earlier step; on FAIL that step re-runs with the verdict as feedback. */
export const check = (name: string, opts: CheckOpts): Step => ({ kind: "check", name, opts });
/** Pauses until a human writes the approval file. */
export const human = (name: string, opts: HumanOpts): Step => ({ kind: "human", name, opts });
/** Steps that run at the same time. */
export const parallel = (...steps: Step[]): Parallel => ({ kind: "parallel", steps });
/** On exhausted retries, re-enter an earlier step instead of blocking. */
export const back = (step: string): OnExhausted => ({ back: step });

/** Turns an agent request into the command to spawn. Swap it to use another CLI. */
export type AgentRunner = (req: { prompt: string; model?: string; tools?: string[] }) => string[];

/**
 * Headless `claude -p` can't ask for permission, so by default it may edit files in
 * the run folder (`acceptEdits`). Steps that need more (Bash, web) list them in `tools`.
 */
export const claude =
  (defaults: { model?: string; extraArgs?: string[] } = {}): AgentRunner =>
  ({ prompt, model, tools }) => {
    const m = model ?? defaults.model;
    return [
      "claude",
      "-p",
      prompt,
      ...(m ? ["--model", m] : []),
      ...(tools?.length ? ["--allowedTools", tools.join(",")] : []),
      ...(defaults.extraArgs ?? ["--permission-mode", "acceptEdits"]),
    ];
  };

export type GraphConfig = {
  name: string;
  /** In order. Each entry starts after the previous one passes. */
  steps: (Step | Parallel)[];
  agent?: AgentRunner;
  /** Per-kind overrides applied to every step of that kind. */
  defaults?: Partial<Record<Kind, ContractOverride>>;
  /** Checked after every step. */
  invariants?: GateCheck[];
  /** Checked once at the end; the run is done only when these pass. */
  goal?: GateCheck[];
  budget?: { minutes?: number; maxReentries?: number };
};

export const defineGraph = (config: GraphConfig): GraphConfig => config;
