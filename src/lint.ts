// Static checks on a graph config, run by `graph plan` before anything executes.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GraphConfig } from "./dsl";
import { resolveStages, type ResolvedStep } from "./contracts";

export function lint(graph: GraphConfig, root: string): { errors: string[]; stages: ResolvedStep[][] } {
  const errors: string[] = [];
  let stages: ResolvedStep[][] = [];
  try {
    stages = resolveStages(graph);
  } catch (e) {
    return { errors: [`could not resolve steps: ${(e as Error).message}`], stages };
  }

  const stageOf = new Map<string, number>();
  const producer = new Map<string, string>();

  stages.forEach((stage, i) => {
    for (const s of stage) {
      if (stageOf.has(s.name)) errors.push(`duplicate step name "${s.name}"`);
      stageOf.set(s.name, i);
      for (const o of [...s.outputs, ...s.optionalOutputs]) {
        const other = producer.get(o);
        if (other) errors.push(`${o} is an output of both "${other}" and "${s.name}"`);
        producer.set(o, s.name);
      }
    }
  });

  stages.forEach((stage, i) => {
    for (const s of stage) {
      if (s.exec.type === "agent" && !existsSync(join(root, s.exec.brief))) errors.push(`${s.name}: brief ${s.exec.brief} not found`);

      if (typeof s.onExhausted === "object") {
        const t = stageOf.get(s.onExhausted.back);
        if (t === undefined) errors.push(`${s.name}: sends back to unknown step "${s.onExhausted.back}"`);
        else if (t > i) errors.push(`${s.name}: sends back to "${s.onExhausted.back}", which runs later`);
      }

      if (s.exec.type === "review") {
        const t = stageOf.get(s.exec.of);
        if (t === undefined) errors.push(`${s.name}: reviews unknown step "${s.exec.of}"`);
        else if (t >= i) errors.push(`${s.name}: reviews "${s.exec.of}", which is not upstream`);
        for (const r of s.exec.reads) {
          const p = producer.get(r);
          if (!p) errors.push(`${s.name}: reads ${r}, which no step produces`);
          else if ((stageOf.get(p) ?? Infinity) >= i) errors.push(`${s.name}: reads ${r} from "${p}", which is not upstream`);
        }
      }

      if (s.checks.length === 0) errors.push(`${s.name}: has no checks, so nothing proves it worked`);
    }
  });

  return { errors, stages };
}
