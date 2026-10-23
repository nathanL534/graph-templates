#!/usr/bin/env bun
// graph init [dir] [--template <name>]   scaffold a project from a template
// graph templates                         list templates
// graph plan                              lint graph.config.ts and print each step's resolved contract
// graph run <key> [--input <file>]       run (or resume) the graph for run <key>; --input is copied to runs/<key>/input.md
// graph status <key>                      per-step state for run <key>
// graph skill                             install the Claude Code skill into ~/.claude/skills/graph
//   --config <path>                       default ./graph.config.ts
// exit codes: 0 ok/done · 1 blocked, failed or lint errors · 2 usage error · 3 waiting on a human

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { GraphConfig } from "./dsl";
import { lint } from "./lint";
import { readState, runGraph } from "./runner";

const PKG = resolve(import.meta.dir, "..");
const TEMPLATES = join(PKG, "templates");

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const configPath = resolve(flag("config") ?? "graph.config.ts");
const template = flag("template") ?? "pipeline";
const inputFile = flag("input");
const [cmd, arg] = args;

async function loadGraph(): Promise<{ graph: GraphConfig; root: string }> {
  if (!existsSync(configPath)) {
    console.error(`no config at ${configPath}. Run \`graph init\` or pass --config.`);
    process.exit(2);
  }
  const mod = await import(configPath);
  return { graph: mod.default as GraphConfig, root: dirname(configPath) };
}

function fmtExhausted(o: unknown) {
  return typeof o === "object" && o && "back" in o ? `back → ${(o as { back: string }).back}` : "block";
}

switch (cmd) {
  case "init": {
    const dest = resolve(arg ?? ".");
    const src = join(TEMPLATES, template);
    if (!existsSync(src)) {
      console.error(`no template "${template}". available: ${readdirSync(TEMPLATES).join(", ")}`);
      process.exit(2);
    }
    if (existsSync(join(dest, "graph.config.ts"))) {
      console.error(`${dest} already has a graph.config.ts`);
      process.exit(2);
    }
    mkdirSync(dest, { recursive: true });
    // Never copy a template's local data: installed deps, run folders, the demo tracker, Finder droppings.
    cpSync(src, dest, { recursive: true, filter: (p) => !/\/(node_modules|runs)(\/|$)|\/(tracker\.jsonl|\.DS_Store)$/.test(p) });
    renameSync(join(dest, "package.template.json"), join(dest, "package.json"));
    renameSync(join(dest, "gitignore.template"), join(dest, ".gitignore"));
    // A local checkout links to itself; an installed copy points at the published repo.
    const spec = PKG.includes("node_modules") ? "github:nathanL534/graph-templates" : `file:${PKG}`;
    const pkgPath = join(dest, "package.json");
    writeFileSync(pkgPath, readFileSync(pkgPath, "utf8").replace("__GRAPH_TEMPLATES_SPEC__", spec));
    console.log(`created ${dest} from template "${template}"`);
    console.log(`next: cd ${arg ?? "."} && bun install && bun run plan && bun run demo`);
    break;
  }

  case "templates":
    for (const t of readdirSync(TEMPLATES)) console.log(t);
    break;

  case "plan": {
    const { graph, root } = await loadGraph();
    const { errors, stages } = lint(graph, root);
    console.log(`graph: ${graph.name}\n`);
    stages.forEach((stage, i) => {
      for (const s of stage) {
        const par = stage.length > 1 ? " ‖" : "";
        console.log(`${String(i + 1).padStart(2)}${par} ${s.name}  [${s.kind}]  retries=${s.retries} (${s.sources.retries})  on exhausted: ${fmtExhausted(s.onExhausted)} (${s.sources.onExhausted})`);
        for (const ch of s.checks) console.log(`      ${ch.id.padEnd(28)} ${s.sources[ch.id]}`);
      }
    });
    if (graph.invariants?.length) console.log(`\ninvariants (after every step): ${graph.invariants.map((c) => c.id).join(", ")}`);
    if (graph.goal?.length) console.log(`goal (at the end): ${graph.goal.map((c) => c.id).join(", ")}`);
    if (errors.length) {
      console.error(`\n${errors.length} error(s):`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(`\nok: ${stages.flat().length} steps in ${stages.length} stages`);
    break;
  }

  case "run": {
    if (!arg) {
      console.error("usage: graph run <key> [--input <file>]");
      process.exit(2);
    }
    const input = inputFile === undefined ? undefined : resolve(inputFile);
    if (input && !existsSync(input)) {
      console.error(`no input file at ${input}`);
      process.exit(2);
    }
    const { graph, root } = await loadGraph();
    const { errors } = lint(graph, root);
    if (errors.length) {
      console.error(`graph has errors; run \`graph plan\`:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
      process.exit(1);
    }
    const result = await runGraph(graph, arg, { root, input });
    process.exit(result === "done" ? 0 : result === "waiting" ? 3 : 1);
  }

  case "status": {
    if (!arg) {
      console.error("usage: graph status <key>");
      process.exit(2);
    }
    const { root } = await loadGraph();
    const state = readState(join(root, "runs", arg));
    if (!state) {
      console.log(`no run "${arg}" yet`);
      break;
    }
    console.log(`${state.graph} / ${arg}: ${state.status ?? "running"}  (re-entries: ${state.reentries})`);
    for (const [name, s] of Object.entries(state.steps)) console.log(`  ${s.status.padEnd(8)} ${name}  attempts=${s.attempts}`);
    break;
  }

  case "skill": {
    const dest = join(homedir(), ".claude", "skills", "graph");
    mkdirSync(dest, { recursive: true });
    cpSync(join(PKG, "skill", "SKILL.md"), join(dest, "SKILL.md"));
    console.log(`installed the graph skill at ${dest}/SKILL.md`);
    break;
  }

  default:
    console.log(`usage:
  graph init [dir] [--template <name>]
  graph templates
  graph plan [--config graph.config.ts]
  graph run <key> [--input <file>]
  graph status <key>
  graph skill
exit codes: 0 ok/done · 1 blocked, failed or lint errors · 2 usage error · 3 waiting on a human`);
    process.exit(cmd ? 2 : 0);
}
