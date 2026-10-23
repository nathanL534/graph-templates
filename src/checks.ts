// Deterministic checks. Every check reads a file or runs a command inside the
// run directory; nothing passes on an agent's word.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Check =
  | { kind: "file_exists"; path: string }
  | { kind: "sections"; path: string; headers: string[]; nonEmpty?: boolean }
  /** negate: pass when the pattern is absent. optional: pass when the file is absent. */
  | { kind: "matches"; path: string; pattern: string; flags?: string; negate?: boolean; optional?: boolean }
  | { kind: "json"; path: string; required: string[]; equals?: Record<string, unknown> }
  | { kind: "command"; run: string }
  /** Fails if the pattern appears in any file of the run (internal .graph/ excluded). */
  | { kind: "scan_forbids"; pattern: string; flags?: string }
  | { kind: "anyOf"; checks: Check[] };

export type GateCheck = Check & {
  id: string;
  /** The failure this check exists to catch. Shown to the agent when it fails. */
  why: string;
};

type Meta = { id?: string; why?: string };

export const verdictPath = (step: string) => `.graph/verdicts/${step}.md`;
/** Last line is the verdict; tolerates markdown bold, a trailing period and trailing whitespace. */
export const VERDICT_PASS = "(^|\\n)[*_ ]*Verdict:[*_ ]*PASS[*_ .]*\\s*$";
export const VERDICT_FAIL = /(^|\n)[*_ ]*Verdict:[*_ ]*FAIL/;

const gate = (check: Check, id: string, why: string, meta: Meta = {}): GateCheck => ({
  ...check,
  id: meta.id ?? id,
  why: meta.why ?? why,
});

const SECRET =
  "(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(password|api[_-]?key|secret|token)[\"']?\\s*[:=]\\s*[\"'][^\"'\\s]{8,})";

/** Builders with sensible default ids and reasons. Pass { id, why } to override either. */
export const checks = {
  fileExists: (path: string, m?: Meta) =>
    gate({ kind: "file_exists", path }, `exists:${path}`, `${path} is a declared output; a step that skips it did not finish.`, m),

  nonEmpty: (path: string, m?: Meta) =>
    gate({ kind: "matches", path, pattern: "\\S" }, `non-empty:${path}`, `An empty ${path} is a no-op pretending to be work.`, m),

  sections: (path: string, headers: string[], m?: Meta) =>
    gate(
      { kind: "sections", path, headers, nonEmpty: true },
      `sections:${path}`,
      `${path} needs non-empty "## ${headers.join('", "## ')}" sections so the next step can rely on them.`,
      m,
    ),

  matches: (path: string, pattern: string, m: Meta & { flags?: string } = {}) =>
    gate({ kind: "matches", path, pattern, flags: m.flags }, `matches:${path}`, `${path} must contain /${pattern}/.`, m),

  forbids: (path: string, pattern: string, m: Meta & { flags?: string; optional?: boolean } = {}) =>
    gate(
      { kind: "matches", path, pattern, flags: m.flags, negate: true, optional: m.optional },
      `forbids:${path}`,
      `${path} must not contain /${pattern}/.`,
      m,
    ),

  json: (path: string, required: string[], m: Meta & { equals?: Record<string, unknown> } = {}) =>
    gate({ kind: "json", path, required, equals: m.equals }, `json:${path}`, `${path} must be valid JSON with ${required.join(", ")}.`, m),

  command: (run: string, m: Meta = {}) =>
    gate({ kind: "command", run }, `command:${run.slice(0, 40)}`, `\`${run}\` must exit 0.`, m),

  anyOf: (list: Check[], m: Meta & { id: string; why: string }) => gate({ kind: "anyOf", checks: list }, m.id, m.why),

  /** The `check` step named `step` ended its verdict with PASS. */
  verdictPassed: (step: string, m?: Meta) =>
    gate(
      { kind: "matches", path: verdictPath(step), pattern: VERDICT_PASS, flags: "" },
      `verdict:${step}`,
      `The ${step} reviewer must end its verdict with "Verdict: PASS".`,
      m,
    ),

  noSecrets: (m?: Meta) =>
    gate(
      { kind: "scan_forbids", pattern: SECRET, flags: "i" },
      "no-secrets",
      "Run artifacts get shared; secrets belong in a gitignored env file.",
      m,
    ),
};

function sectionBody(text: string, header: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${header}`);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === ".graph" || name === "node_modules" || name.endsWith(".env")) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (s.size < 1_000_000) yield p;
  }
}

/** Returns null on pass, or the reason it failed. `scope` limits scan_forbids to these files. */
export function evaluate(check: Check, dir: string, scope?: string[]): string | null {
  const file = "path" in check ? join(dir, check.path) : "";
  switch (check.kind) {
    case "file_exists":
      return existsSync(file) ? null : `missing ${check.path}`;

    case "sections": {
      if (!existsSync(file)) return `missing ${check.path}`;
      const text = readFileSync(file, "utf8");
      for (const h of check.headers) {
        const body = sectionBody(text, h);
        if (body === null) return `${check.path}: no "## ${h}" section`;
        if (check.nonEmpty && body.trim() === "") return `${check.path}: "## ${h}" is empty`;
      }
      return null;
    }

    case "matches": {
      if (!existsSync(file)) return check.optional ? null : `missing ${check.path}`;
      const found = new RegExp(check.pattern, check.flags ?? "m").test(readFileSync(file, "utf8"));
      if (check.negate) return found ? `${check.path}: forbidden pattern /${check.pattern}/ present` : null;
      return found ? null : `${check.path}: pattern /${check.pattern}/ not found`;
    }

    case "json": {
      if (!existsSync(file)) return `missing ${check.path}`;
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return `${check.path}: invalid JSON`;
      }
      for (const k of check.required) {
        if (getPath(data, k) === undefined) return `${check.path}: missing key "${k}"`;
      }
      for (const [k, v] of Object.entries(check.equals ?? {})) {
        if (JSON.stringify(getPath(data, k)) !== JSON.stringify(v)) return `${check.path}: "${k}" is not ${JSON.stringify(v)}`;
      }
      return null;
    }

    case "command": {
      const proc = Bun.spawnSync(["bash", "-c", check.run], { cwd: dir, stderr: "pipe" });
      if (proc.exitCode === 0) return null;
      const err = proc.stderr.toString().trim().split("\n").at(-1) ?? "";
      const label = check.run.trim().split("\n")[0]!.slice(0, 60) + (check.run.trim().length > 60 ? "…" : "");
      return `\`${label}\` exited ${proc.exitCode}${err ? ` (${err})` : ""}`;
    }

    case "scan_forbids": {
      const re = new RegExp(check.pattern, check.flags ?? "m");
      const files = scope ? scope.map((f) => join(dir, f)).filter((f) => existsSync(f) && statSync(f).isFile()) : walk(dir);
      for (const p of files) {
        if (re.test(readFileSync(p, "utf8"))) return `forbidden pattern found in ${p.slice(dir.length + 1)}`;
      }
      return null;
    }

    case "anyOf": {
      const reasons = check.checks.map((c) => evaluate(c, dir, scope));
      return reasons.includes(null) ? null : `none passed: ${reasons.join(" | ")}`;
    }
  }
}
