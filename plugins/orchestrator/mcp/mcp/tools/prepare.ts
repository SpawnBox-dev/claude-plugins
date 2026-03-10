import type { Database } from "bun:sqlite";
import type { ContextPackage, AutonomyLevel } from "../types";
import { composeContextPackage } from "../engine/composer";
import { computeAutonomyScore } from "../engine/scorer";
import { truncate } from "../utils";

export interface PrepareInput {
  task: string;
  domain?: string;
}

export interface PrepareResult {
  package: ContextPackage;
  autonomy: AutonomyLevel;
  formatted: string;
}

const DOMAIN_PATTERNS: Array<[RegExp, string]> = [
  [/\b(react|component|tsx|jsx|frontend|ui|tailwind|daisyui|zustand)\b/i, "frontend"],
  [/\b(rust|tauri|cargo|backend|command|handler)\b/i, "backend"],
  [/\b(worker|cloudflare|wrangler|d1|r2|kv|pages)\b/i, "cloud"],
  [/\b(docker|wsl|container|infra|infrastructure|deploy)\b/i, "infra"],
  [/\b(test|vitest|bun:test|spec|e2e|integration)\b/i, "testing"],
  [/\b(discord|bot|webhook|guild|channel)\b/i, "discord"],
];

function inferDomain(task: string): string {
  for (const [pattern, domain] of DOMAIN_PATTERNS) {
    if (pattern.test(task)) return domain;
  }
  return "general";
}

function formatPackage(pkg: ContextPackage, domain: string, autonomy: AutonomyLevel): string {
  const lines: string[] = [];
  lines.push(`# Context Package: ${domain}`);
  lines.push("");

  // Autonomy guidance based on domain maturity
  if (autonomy === "mature") {
    lines.push(`**Autonomy: MATURE** - This domain has rich context. Proceed confidently using established patterns. Only escalate on conflicts with existing conventions or novel architectural decisions.`);
  } else if (autonomy === "developing") {
    lines.push(`**Autonomy: DEVELOPING** - Some patterns established. Follow existing conventions where they exist. For gaps, propose approaches and record decisions.`);
  } else {
    lines.push(`**Autonomy: SPARSE** - Limited context for this domain. Be cautious - ask before making architectural decisions. Record everything you learn for future sessions.`);
  }
  lines.push("");

  const sections: Array<[string, typeof pkg.conventions]> = [
    ["Conventions", pkg.conventions],
    ["Tool Capabilities", pkg.tool_capabilities],
    ["Anti-Patterns (DO NOT)", pkg.anti_patterns],
    ["Quality Gates (MUST PASS)", pkg.quality_gates],
    ["Architecture", pkg.architecture],
    ["Constraints", pkg.constraints],
    ["Recent Decisions", pkg.recent_decisions],
  ];

  for (const [title, notes] of sections) {
    if (notes.length > 0) {
      lines.push(`## ${title}`);
      for (const note of notes) {
        lines.push(`- [${note.confidence}] ${truncate(note.content, 120)}`);
      }
      lines.push("");
    }
  }

  if (lines.length <= 4) {
    lines.push("No domain-specific context found. Knowledge will accumulate as you work.");
    lines.push("");
  }

  return lines.join("\n");
}

export function handlePrepare(
  projectDb: Database,
  globalDb: Database,
  input: PrepareInput
): PrepareResult {
  const domain = input.domain ?? inferDomain(input.task);
  const pkg = composeContextPackage(projectDb, globalDb, domain);
  const autonomyResult = computeAutonomyScore(projectDb, domain);
  const formatted = formatPackage(pkg, domain, autonomyResult.score);

  return { package: pkg, autonomy: autonomyResult.score, formatted };
}
