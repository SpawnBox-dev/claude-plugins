/**
 * Conceptual Completeness Checks
 *
 * 2026-01-07 REFACTOR NOTE:
 * This module now provides INFORMATIONAL pattern matching results.
 * The LLM calling this tool decides if the doc is "good enough" based on context.
 * Scores and passesConceptualReview are kept for backward compatibility but
 * should NOT be treated as authoritative pass/fail verdicts.
 *
 * What this module does:
 * - Runs configurable regex patterns against document content
 * - Reports which patterns matched and which didn't
 * - Provides the doc type's verification strategy as context
 *
 * What the calling LLM should do:
 * - Use pattern match results as signals, not absolute requirements
 * - Consider document context when interpreting results
 * - Make semantic judgments about quality and completeness
 *
 * CONFIGURATION: Checks are loaded from config.ts based on detected preset.
 */

import * as fs from 'fs';
import {
  getDocTypeConfig,
  getVerificationStrategy as getConfigVerificationStrategy,
  compilePatterns,
  getAllDocTypes,
  type ConceptualCheckConfig,
} from './config.js';

// ============================================================================
// Types
// ============================================================================

export interface ConceptualCheck {
  name: string;
  description: string;
  required: boolean;
  patterns: RegExp[]; // Compiled patterns
  suggestions: string[];
}

export interface ConceptualReport {
  docPath: string;
  docType: string;
  checks: ConceptualCheckResult[];
  score: number; // 0-100
  passesConceptualReview: boolean;
  guidance: string[];
}

export interface ConceptualCheckResult {
  check: ConceptualCheck;
  found: boolean;
  matchedText?: string;
}

// ============================================================================
// Doc Type Classification
// ============================================================================

export type VerificationStrategy = 'source-facts' | 'conceptual' | 'hybrid';

/**
 * Get verification strategy from config
 */
export function getVerificationStrategy(docType: string): VerificationStrategy {
  return getConfigVerificationStrategy(docType);
}

/**
 * Get human-readable explanation of why this strategy applies
 */
export function getStrategyExplanation(docType: string): string {
  const strategy = getVerificationStrategy(docType);
  const config = getDocTypeConfig(docType);
  const typeName = config?.name || docType;

  switch (strategy) {
    case 'source-facts':
      return `**${typeName}** docs should accurately reflect code details (function signatures, table schemas, etc.). Source fact verification is appropriate.`;

    case 'conceptual':
      return `**${typeName}** docs should explain design rationale, system relationships, and things the code can't express. Conceptual completeness is more important than mentioning every struct name.`;

    case 'hybrid':
      return `**${typeName}** docs need both: accurate code references AND conceptual explanation. Use source verification for key types, but prioritize design rationale and gotchas.`;
  }
}

// ============================================================================
// Check Loading from Config
// ============================================================================

/**
 * Load conceptual checks for a doc type from config
 * Converts stored string patterns to RegExp
 */
function loadChecksForDocType(docType: string): ConceptualCheck[] {
  const config = getDocTypeConfig(docType);
  if (!config) return [];

  return config.conceptualChecks.map((check: ConceptualCheckConfig) => ({
    name: check.name,
    description: check.description,
    required: check.required,
    patterns: compilePatterns(check.patterns),
    suggestions: check.suggestions,
  }));
}

// ============================================================================
// Verification Functions
// ============================================================================

/**
 * Run conceptual completeness checks on a document
 *
 * 2026-01-07 REFACTOR: This now provides informational results.
 * The score and passesConceptualReview are kept for backward compatibility
 * but the LLM should make its own judgment about document quality.
 */
export function runConceptualChecks(
  docPath: string,
  docType: string
): ConceptualReport {
  const checks = loadChecksForDocType(docType);
  const results: ConceptualCheckResult[] = [];
  const guidance: string[] = [];

  let docContent = '';
  if (fs.existsSync(docPath)) {
    docContent = fs.readFileSync(docPath, 'utf-8');
  }

  for (const check of checks) {
    let found = false;
    let matchedText: string | undefined;

    for (const pattern of check.patterns) {
      const match = docContent.match(pattern);
      if (match) {
        found = true;
        matchedText = match[0];
        break;
      }
    }

    results.push({ check, found, matchedText });

    // Collect pattern suggestions for missing items (informational, not prescriptive)
    if (!found) {
      guidance.push(`**Pattern not found: ${check.name}** (${check.required ? 'marked as required in config' : 'optional'})`);
      guidance.push(`  ${check.description}`);
      if (check.suggestions.length > 0) {
        guidance.push('  Example patterns to consider:');
        for (const suggestion of check.suggestions) {
          guidance.push(`  - ${suggestion}`);
        }
      }
      guidance.push('');
    }
  }

  // Calculate score (for backward compatibility - LLM should not rely on this solely)
  const requiredChecks = results.filter((r) => r.check.required);
  const passedRequired = requiredChecks.filter((r) => r.found);
  const optionalChecks = results.filter((r) => !r.check.required);
  const passedOptional = optionalChecks.filter((r) => r.found);

  const requiredScore =
    requiredChecks.length > 0
      ? (passedRequired.length / requiredChecks.length) * 70
      : 70;
  const optionalScore =
    optionalChecks.length > 0
      ? (passedOptional.length / optionalChecks.length) * 30
      : 30;

  const score = Math.round(requiredScore + optionalScore);

  return {
    docPath,
    docType,
    checks: results,
    score,
    passesConceptualReview: passedRequired.length === requiredChecks.length,
    guidance,
  };
}

/**
 * Generate a human-readable report from conceptual checks
 *
 * 2026-01-07 REFACTOR: Report is now informational.
 * The LLM reading this should interpret results in context.
 */
export function formatConceptualReport(report: ConceptualReport): string {
  const lines: string[] = [];

  lines.push(`## Pattern Match Results`);
  lines.push('');
  lines.push(
    `**Document Type**: ${report.docType} (strategy: ${getVerificationStrategy(report.docType)})`
  );
  lines.push(
    `**Pattern Score**: ${report.score}/100 (informational - LLM should judge quality)`
  );
  lines.push('');
  lines.push('> **Note**: These are pattern-based signals. The calling LLM should');
  lines.push('> interpret results in context and make semantic quality judgments.');
  lines.push('');

  // Group checks by status
  const matched = report.checks.filter((r) => r.found);
  const notMatched = report.checks.filter((r) => !r.found);

  if (matched.length > 0) {
    lines.push('### Patterns Matched');
    for (const result of matched) {
      const marker = result.check.required ? '(config: required)' : '(config: optional)';
      lines.push(`- **${result.check.name}** ${marker}`);
    }
    lines.push('');
  }

  if (notMatched.length > 0) {
    lines.push('### Patterns Not Matched');
    for (const result of notMatched) {
      const marker = result.check.required ? '(config: required)' : '(config: optional)';
      lines.push(`- **${result.check.name}** ${marker}`);
      lines.push(`  - Looking for: ${result.check.description}`);
    }
    lines.push('');
  }

  if (report.guidance.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('### Pattern Details');
    lines.push('');
    for (const line of report.guidance) {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

/**
 * Get guidance for a specific doc type about what kind of verification to use
 */
export function getDocTypeGuidance(docType: string): string {
  const strategy = getVerificationStrategy(docType);
  const config = getDocTypeConfig(docType);
  const typeName = config?.name || docType;

  switch (strategy) {
    case 'source-facts':
      return `This is a **${typeName}** document. Focus on:
- Accurate function signatures and types
- Complete parameter documentation
- Up-to-date error codes and responses
- Code examples that actually compile/run

Use \`docs_verify_against_source\` to check accuracy.`;

    case 'conceptual':
      return `This is a **${typeName}** document. Focus on:
- Design rationale (WHY, not just WHAT)
- System relationships and data flow
- Gotchas and edge cases
- Extension guidance for future developers

Do NOT focus on mentioning every struct name - that's what code is for.`;

    case 'hybrid':
      return `This is a **${typeName}** document. Balance:
- Key type/struct documentation (use \`filterTypes\` to scope)
- Design principles and rationale
- Architecture diagrams
- Practical gotchas

Use source verification for core types only, not exhaustive code mirroring.`;
  }
}

/**
 * Get list of available doc types from config
 */
export function getAvailableDocTypes(): string[] {
  return getAllDocTypes();
}
