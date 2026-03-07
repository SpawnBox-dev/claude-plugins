/**
 * Source Verification System
 *
 * Extracts concrete facts from source files and verifies documentation
 * contains these facts. This prevents "copies of copies" degradation
 * by anchoring documentation to actual source code.
 *
 * Key insight: LLMs are better at targeted edits than full rewrites.
 * By identifying exactly what's wrong, we enable surgical fixes instead
 * of lossy regeneration.
 *
 * EXTENSIBLE: Language extractors are registered via registerExtractor().
 * Built-in extractors: Rust (.rs), TypeScript (.ts, .tsx)
 */

import * as fs from 'fs';
import * as path from 'path';
import { isLanguageEnabled, type LanguageId } from './config.js';

// ============================================================================
// Types
// ============================================================================

export interface SourceFact {
  file: string;
  line?: number;
  factType: string; // Extensible - each language can define its own fact types
  name: string;
  details: string; // e.g., "pub id: Uuid" or "interface Props { ... }"
  searchPattern: string; // What to look for in docs
}

/**
 * A language extractor function signature
 */
export type FactExtractor = (
  filePath: string,
  projectRoot: string,
  filterNames?: string[]
) => SourceFact[];

/**
 * Registry of language extractors by file extension
 */
const extractorRegistry: Map<string, { extractor: FactExtractor; language: LanguageId }> = new Map();

export interface VerificationResult {
  fact: SourceFact;
  found: boolean;
  docLocation?: string; // Where it was found in doc
  suggestion?: string; // What to add/fix if missing
}

export interface SourceVerificationReport {
  sourcePath: string;
  docPath: string;
  facts: SourceFact[];
  verificationResults: VerificationResult[];
  missingFacts: SourceFact[];
  wrongFacts: { fact: SourceFact; foundText: string; correctText: string }[];
  score: number; // 0-100 - informational, LLM should interpret in context
  /**
   * @deprecated Kept for backward compatibility. LLM should make its own judgment
   * based on context, doc type, and which specific facts are missing.
   * A low score might be acceptable for architecture docs but not for API docs.
   */
  passesVerification: boolean;
}

// ============================================================================
// Extractor Registry
// ============================================================================

/**
 * Register a fact extractor for a file extension
 * @param extension - File extension including dot (e.g., '.rs', '.py')
 * @param language - Language ID for config-based enabling
 * @param extractor - The extraction function
 */
export function registerExtractor(
  extension: string,
  language: LanguageId,
  extractor: FactExtractor
): void {
  extractorRegistry.set(extension.toLowerCase(), { extractor, language });
}

/**
 * Get the appropriate extractor for a file
 * Returns undefined if no extractor is registered or language is disabled
 */
export function getExtractor(filePath: string): FactExtractor | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const entry = extractorRegistry.get(ext);

  if (!entry) return undefined;
  if (!isLanguageEnabled(entry.language)) return undefined;

  return entry.extractor;
}

/**
 * Extract facts from a file using the appropriate registered extractor
 */
export function extractFacts(
  filePath: string,
  projectRoot: string,
  filterNames?: string[]
): SourceFact[] {
  const extractor = getExtractor(filePath);
  if (!extractor) return [];
  return extractor(filePath, projectRoot, filterNames);
}

/**
 * Get list of supported file extensions
 */
export function getSupportedExtensions(): string[] {
  return Array.from(extractorRegistry.keys()).filter((ext) => {
    const entry = extractorRegistry.get(ext);
    return entry && isLanguageEnabled(entry.language);
  });
}

// ============================================================================
// Rust Source Fact Extraction
// ============================================================================

/**
 * Extract concrete facts from a Rust source file
 * This is intentionally conservative - we only extract things we're confident about
 *
 * @param filePath - Path to the Rust source file
 * @param projectRoot - Root of the project for relative paths
 * @param filterNames - Optional array of struct/enum names to extract. If provided, only
 *                      extracts facts for items whose names are in this list (and their fields/variants).
 *                      This is crucial for large files like lib.rs that contain many unrelated types.
 */
export function extractRustFacts(
  filePath: string,
  projectRoot: string,
  filterNames?: string[]
): SourceFact[] {
  const facts: SourceFact[] = [];
  const relativePath = path.relative(projectRoot, filePath);

  if (!fs.existsSync(filePath)) {
    return facts;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Convert filter to Set for fast lookup (case-insensitive)
  const filterSet = filterNames
    ? new Set(filterNames.map((n) => n.toLowerCase()))
    : null;

  // Helper to check if a name passes the filter
  const passesFilter = (name: string): boolean => {
    if (!filterSet) return true;
    return filterSet.has(name.toLowerCase());
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Extract pub struct definitions
    const structMatch = line.match(/^pub struct (\w+)/);
    if (structMatch) {
      const structName = structMatch[1];

      // Only include if passes filter (or no filter)
      if (!passesFilter(structName)) continue;

      facts.push({
        file: relativePath,
        line: lineNum,
        factType: 'struct',
        name: structName,
        details: `pub struct ${structName}`,
        searchPattern: structName,
      });

      // Extract fields from the struct (look ahead for pub fields)
      for (let j = i + 1; j < lines.length && j < i + 30; j++) {
        const fieldLine = lines[j];
        if (fieldLine.includes('}') && !fieldLine.includes('{')) break;

        const fieldMatch = fieldLine.match(/^\s*pub (\w+):\s*([^,}]+)/);
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          const fieldType = fieldMatch[2].trim();
          facts.push({
            file: relativePath,
            line: j + 1,
            factType: 'field',
            name: `${structName}.${fieldName}`,
            details: `pub ${fieldName}: ${fieldType}`,
            searchPattern: `${fieldName}.*${simplifyType(fieldType)}`,
          });
        }
      }
    }

    // Extract pub enum definitions
    const enumMatch = line.match(/^pub enum (\w+)/);
    if (enumMatch) {
      const enumName = enumMatch[1];

      // Only include if passes filter (or no filter)
      if (!passesFilter(enumName)) continue;

      facts.push({
        file: relativePath,
        line: lineNum,
        factType: 'enum',
        name: enumName,
        details: `pub enum ${enumName}`,
        searchPattern: enumName,
      });

      // Extract variants
      for (let j = i + 1; j < lines.length && j < i + 50; j++) {
        const variantLine = lines[j];
        if (variantLine.match(/^}/) || variantLine.match(/^pub /)) break;

        const variantMatch = variantLine.match(/^\s*(\w+)(?:\(|,|\s*$)/);
        if (variantMatch && !variantMatch[1].startsWith('//')) {
          facts.push({
            file: relativePath,
            line: j + 1,
            factType: 'variant',
            name: `${enumName}::${variantMatch[1]}`,
            details: variantMatch[1],
            searchPattern: variantMatch[1],
          });
        }
      }
    }

    // Extract const definitions (always included if no filter, or if name matches)
    const constMatch = line.match(/^(?:pub\s+)?const (\w+):\s*(\w+)\s*=\s*(.+?);/);
    if (constMatch) {
      const constName = constMatch[1];
      if (passesFilter(constName)) {
        facts.push({
          file: relativePath,
          line: lineNum,
          factType: 'const',
          name: constName,
          details: `const ${constName}: ${constMatch[2]} = ${constMatch[3]}`,
          searchPattern: `${constName}.*${constMatch[3]}`,
        });
      }
    }

    // Extract pub fn definitions (always included if no filter, or if name matches)
    const fnMatch = line.match(/^\s*pub fn (\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?/);
    if (fnMatch) {
      const fnName = fnMatch[1];
      if (passesFilter(fnName)) {
        const params = fnMatch[2];
        const returnType = fnMatch[3]?.trim() || 'void';
        facts.push({
          file: relativePath,
          line: lineNum,
          factType: 'function',
          name: fnName,
          details: `pub fn ${fnName}(${summarizeParams(params)}) -> ${simplifyType(returnType)}`,
          searchPattern: fnName,
        });
      }
    }
  }

  return facts;
}

// ============================================================================
// TypeScript Source Fact Extraction (Framework-Agnostic)
// ============================================================================

/**
 * Extract concrete facts from a TypeScript source file
 * Extracts: interfaces, types, components (any framework), hooks, stores (any state manager)
 *
 * This extractor is framework-agnostic:
 * - Components: Any PascalCase exported function returning JSX works
 * - Stores: Detects create(), defineStore(), createStore(), etc.
 * - Hooks: Any use* exported function
 *
 * @param filePath - Path to the TypeScript source file
 * @param projectRoot - Root of the project for relative paths
 * @param filterNames - Optional array of names to extract. If provided, only
 *                      extracts facts for items whose names are in this list.
 */
export function extractTypeScriptFacts(
  filePath: string,
  projectRoot: string,
  filterNames?: string[]
): SourceFact[] {
  const facts: SourceFact[] = [];
  const relativePath = path.relative(projectRoot, filePath);

  if (!fs.existsSync(filePath)) {
    return facts;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Convert filter to Set for fast lookup (case-insensitive)
  const filterSet = filterNames
    ? new Set(filterNames.map((n) => n.toLowerCase()))
    : null;

  const passesFilter = (name: string): boolean => {
    if (!filterSet) return true;
    return filterSet.has(name.toLowerCase());
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Extract interface definitions
    const interfaceMatch = line.match(/^export\s+interface\s+(\w+)/);
    if (interfaceMatch) {
      const name = interfaceMatch[1];
      if (passesFilter(name)) {
        facts.push({
          file: relativePath,
          line: lineNum,
          factType: 'interface',
          name,
          details: `interface ${name}`,
          searchPattern: name,
        });

        // Extract props from interface (look ahead)
        for (let j = i + 1; j < lines.length && j < i + 30; j++) {
          const propLine = lines[j];
          if (propLine.match(/^}/)) break;

          const propMatch = propLine.match(/^\s*(\w+)(\?)?:\s*([^;]+)/);
          if (propMatch && !propMatch[1].startsWith('//')) {
            const propName = propMatch[1];
            const optional = propMatch[2] === '?';
            const propType = propMatch[3].trim();
            facts.push({
              file: relativePath,
              line: j + 1,
              factType: 'prop',
              name: `${name}.${propName}`,
              details: `${propName}${optional ? '?' : ''}: ${propType}`,
              searchPattern: propName,
            });
          }
        }
      }
    }

    // Extract type definitions
    const typeMatch = line.match(/^export\s+type\s+(\w+)\s*=\s*(.+)/);
    if (typeMatch) {
      const name = typeMatch[1];
      if (passesFilter(name)) {
        const definition = typeMatch[2].replace(/;$/, '').trim();
        facts.push({
          file: relativePath,
          line: lineNum,
          factType: 'type',
          name,
          details: `type ${name} = ${definition.slice(0, 50)}${definition.length > 50 ? '...' : ''}`,
          searchPattern: name,
        });
      }
    }

    // Extract UI components (framework-agnostic)
    // Works for: React (FC, arrow functions), Vue (defineComponent), Svelte, etc.
    // Key insight: PascalCase exported functions that contain JSX/template syntax
    const componentMatch = line.match(
      /^export\s+(?:const|function)\s+([A-Z]\w+)/
    );
    if (componentMatch) {
      const name = componentMatch[1];
      if (passesFilter(name)) {
        // Check if it looks like a component (returns JSX, has template, uses defineComponent, etc.)
        let isComponent = false;
        let componentType = 'component'; // Generic label

        // Look ahead for component indicators
        for (let j = i; j < lines.length && j < i + 50; j++) {
          const checkLine = lines[j];
          // JSX return (React, Solid, etc.)
          if (checkLine.match(/return\s*\(?\s*</)) {
            isComponent = true;
            break;
          }
          // Vue defineComponent
          if (checkLine.match(/defineComponent/)) {
            isComponent = true;
            break;
          }
          // Arrow function with JSX
          if (checkLine.match(/=>\s*\(?\s*</)) {
            isComponent = true;
            break;
          }
          // React.FC or FC type annotation
          if (checkLine.match(/:\s*(?:React\.)?FC/)) {
            isComponent = true;
            break;
          }
          // Hit next export, stop looking
          if (j > i && checkLine.match(/^export\s/)) break;
        }

        if (isComponent && !facts.some((f) => f.name === name && f.factType === 'component')) {
          facts.push({
            file: relativePath,
            line: lineNum,
            factType: 'component',
            name,
            details: `${componentType} ${name}`,
            searchPattern: name,
          });
        }
      }
    }

    // Extract custom hooks
    const hookMatch = line.match(/^export\s+(?:const|function)\s+(use\w+)/);
    if (hookMatch) {
      const name = hookMatch[1];
      if (passesFilter(name)) {
        facts.push({
          file: relativePath,
          line: lineNum,
          factType: 'hook',
          name,
          details: `custom hook ${name}`,
          searchPattern: name,
        });
      }
    }

    // Extract state store definitions (framework-agnostic)
    // Works for: Zustand (create), Pinia (defineStore), Redux (createSlice), MobX, etc.
    const storePatterns = [
      /^export\s+const\s+(use\w*Store)\s*=\s*create/,           // Zustand: useXStore = create
      /^(?:export\s+)?const\s+(\w+Store)\s*=\s*create</,        // Zustand: xStore = create<
      /^export\s+const\s+(use\w+)\s*=\s*defineStore/,           // Pinia: useX = defineStore
      /^(?:export\s+)?const\s+(\w+Slice)\s*=\s*createSlice/,    // Redux Toolkit
      /^(?:export\s+)?const\s+(\w+Store)\s*=\s*(?:observable|makeAutoObservable)/, // MobX
    ];

    for (const pattern of storePatterns) {
      const storeMatch = line.match(pattern);
      if (storeMatch) {
        const name = storeMatch[1];
        if (passesFilter(name) && !facts.some((f) => f.name === name && f.factType === 'store')) {
          facts.push({
            file: relativePath,
            line: lineNum,
            factType: 'store',
            name,
            details: `state store ${name}`,
            searchPattern: name,
          });
        }
        break; // Only match one pattern per line
      }
    }

    // Extract const exports (for configuration objects, etc.)
    const constMatch = line.match(/^export\s+const\s+([A-Z][A-Z_0-9]+)\s*[=:]/);
    if (constMatch) {
      const name = constMatch[1];
      if (passesFilter(name)) {
        facts.push({
          file: relativePath,
          line: lineNum,
          factType: 'const',
          name,
          details: `const ${name}`,
          searchPattern: name,
        });
      }
    }
  }

  return facts;
}

/**
 * Simplify a Rust type for documentation matching
 * e.g., "DateTime<Utc>" stays as-is, but "Option<String>" becomes "Option<String>"
 */
function simplifyType(type: string): string {
  return type
    .replace(/\s+/g, '')
    .replace(/,/g, ', ');
}

/**
 * Summarize function parameters for documentation
 */
function summarizeParams(params: string): string {
  if (!params.trim()) return '';

  const paramList = params.split(',').map((p) => {
    const match = p.trim().match(/(\w+):\s*(.+)/);
    if (match) {
      return `${match[1]}: ${simplifyType(match[2])}`;
    }
    return p.trim();
  });

  if (paramList.length > 3) {
    return `${paramList.slice(0, 2).join(', ')}, ...`;
  }
  return paramList.join(', ');
}

// ============================================================================
// Documentation Verification
// ============================================================================

/**
 * Verify that a documentation file contains the required source facts
 */
export function verifyDocAgainstFacts(
  docPath: string,
  facts: SourceFact[]
): VerificationResult[] {
  if (!fs.existsSync(docPath)) {
    return facts.map((fact) => ({
      fact,
      found: false,
      suggestion: `Add documentation for ${fact.name}: ${fact.details}`,
    }));
  }

  const docContent = fs.readFileSync(docPath, 'utf-8').toLowerCase();
  const results: VerificationResult[] = [];

  for (const fact of facts) {
    const searchLower = fact.searchPattern.toLowerCase();
    const found = docContent.includes(searchLower) ||
      docContent.includes(fact.name.toLowerCase());

    results.push({
      fact,
      found,
      suggestion: found
        ? undefined
        : `Missing: ${fact.factType} "${fact.name}" (${fact.details}) from ${fact.file}:${fact.line}`,
    });
  }

  return results;
}

/**
 * Generate a full verification report comparing doc against source
 *
 * @param docPath - Path to the documentation file
 * @param sourcePaths - Array of source file paths
 * @param projectRoot - Root of the project
 * @param filterNames - Optional array of type/const/function names to filter extraction.
 *                      Use this for large files to only extract relevant types.
 */
export function generateVerificationReport(
  docPath: string,
  sourcePaths: string[],
  projectRoot: string,
  filterNames?: string[]
): SourceVerificationReport {
  // Extract facts from all source files using the pluggable registry
  const allFacts: SourceFact[] = [];
  for (const sourcePath of sourcePaths) {
    const fullPath = path.isAbsolute(sourcePath)
      ? sourcePath
      : path.join(projectRoot, sourcePath);

    if (!fs.existsSync(fullPath)) continue;

    // Use the pluggable extractor registry
    const facts = extractFacts(fullPath, projectRoot, filterNames);
    allFacts.push(...facts);
  }

  // Filter to only "important" facts
  // These are language-agnostic categories of "important" things to document
  const importantFactTypes = new Set([
    // Rust
    'struct', 'enum', 'const',
    // TypeScript
    'interface', 'type', 'component', 'store', 'hook',
    // Python (future)
    'class', 'dataclass', 'function',
    // Go (future)
    'struct', 'interface', 'func',
  ]);

  const importantFacts = allFacts.filter((f) => {
    if (importantFactTypes.has(f.factType)) return true;
    // Special case: fields that look important
    if (f.factType === 'field' && isImportantField(f.name)) return true;
    return false;
  });

  // Verify against doc
  const verificationResults = verifyDocAgainstFacts(docPath, importantFacts);
  const missingFacts = verificationResults
    .filter((r) => !r.found)
    .map((r) => r.fact);

  // Calculate score
  const foundCount = verificationResults.filter((r) => r.found).length;
  const score = importantFacts.length > 0
    ? Math.round((foundCount / importantFacts.length) * 100)
    : 100;

  return {
    sourcePath: sourcePaths.join(', '),
    docPath,
    facts: importantFacts,
    verificationResults,
    missingFacts,
    wrongFacts: [], // TODO: implement wrong fact detection
    score,
    // INFORMATIONAL: 80% is a rough heuristic. The calling LLM should
    // consider doc type (API docs need higher accuracy than architecture docs)
    // and which specific facts are missing (core types vs. minor helpers).
    passesVerification: score >= 80,
  };
}

/**
 * Check if a field is "important" enough to require documentation
 * We don't want to require every single field, just key ones
 *
 * This uses heuristics rather than hardcoded lists for broader applicability:
 * - Fields named 'id', 'name', 'type', 'status' are usually important
 * - Fields from types with few fields (<=5) are likely all important
 * - Fields that are public and non-internal (not prefixed with _)
 */
function isImportantField(fieldName: string): boolean {
  const parts = fieldName.split('.');
  if (parts.length !== 2) return false;

  const field = parts[1].toLowerCase();

  // Common important field patterns across any domain
  const importantPatterns = [
    'id', 'uuid', 'name', 'type', 'kind', 'status', 'state',
    'timestamp', 'created', 'updated', 'date', 'time',
    'source', 'target', 'parent', 'owner',
    'key', 'value', 'data', 'content', 'payload',
  ];

  // Check if field matches any important pattern
  return importantPatterns.some((pattern) => field.includes(pattern));
}

// ============================================================================
// Diff-Based Update Suggestions
// ============================================================================

/**
 * Generate targeted edit suggestions based on verification results
 * This is the key to preventing "copies of copies" - we suggest specific edits
 * rather than full rewrites
 */
export function generateEditSuggestions(
  report: SourceVerificationReport
): string[] {
  const suggestions: string[] = [];

  if (report.missingFacts.length === 0) {
    suggestions.push('No missing facts detected. Document appears accurate.');
    return suggestions;
  }

  suggestions.push(`## ${report.missingFacts.length} Missing Facts Detected\n`);
  suggestions.push('Make TARGETED EDITS to add these facts. Do NOT rewrite the entire document.\n');

  // Group by fact type
  const byType = new Map<string, SourceFact[]>();
  for (const fact of report.missingFacts) {
    const existing = byType.get(fact.factType) || [];
    existing.push(fact);
    byType.set(fact.factType, existing);
  }

  // Generate suggestions by type
  for (const [type, facts] of byType) {
    suggestions.push(`\n### Missing ${type}s:\n`);
    for (const fact of facts) {
      suggestions.push(`- **${fact.name}**: \`${fact.details}\``);
      suggestions.push(`  - Source: ${fact.file}:${fact.line}`);
      suggestions.push(`  - Add to documentation: Document that ${fact.name} ${describeFactType(fact)}`);
    }
  }

  suggestions.push('\n---');
  suggestions.push('**IMPORTANT**: Use the Edit tool to make surgical changes.');
  suggestions.push('Do NOT use Write to replace the entire file.');
  suggestions.push('Preserve all existing correct content verbatim.');

  return suggestions;
}

function describeFactType(fact: SourceFact): string {
  switch (fact.factType) {
    case 'struct':
      return `is a struct defined at ${fact.file}:${fact.line}`;
    case 'enum':
      return `is an enum defined at ${fact.file}:${fact.line}`;
    case 'const':
      return `has value ${fact.details.split('=')[1]?.trim()}`;
    case 'field':
      return `has type ${fact.details.split(':')[1]?.trim()}`;
    case 'function':
      return `is a function with signature ${fact.details}`;
    case 'variant':
      return `is a variant of the parent enum`;
    default:
      return fact.details;
  }
}

// ============================================================================
// Backup-Assisted Workflow
// ============================================================================

/**
 * Compare a backup doc with current source to identify what needs updating
 * This enables targeted edits instead of full rewrites
 */
export function compareBackupToSource(
  backupDocPath: string,
  currentDocPath: string,
  sourcePaths: string[],
  projectRoot: string
): {
  backupReport: SourceVerificationReport;
  currentReport: SourceVerificationReport;
  newIssues: SourceFact[]; // Facts in source but not in current doc
  fixedIssues: SourceFact[]; // Facts that were missing in backup but present in current
  regressions: SourceFact[]; // Facts that were in backup but missing in current (BAD!)
} {
  const backupReport = generateVerificationReport(backupDocPath, sourcePaths, projectRoot);
  const currentReport = generateVerificationReport(currentDocPath, sourcePaths, projectRoot);

  const backupMissing = new Set(backupReport.missingFacts.map((f) => f.name));
  const currentMissing = new Set(currentReport.missingFacts.map((f) => f.name));

  // Facts that source has but current doc doesn't
  const newIssues = currentReport.missingFacts;

  // Facts that were missing in backup but now present in current (good!)
  const fixedIssues = backupReport.missingFacts.filter(
    (f) => !currentMissing.has(f.name)
  );

  // Facts that were in backup but now missing in current (regression!)
  const backupHad = backupReport.facts.filter((f) => !backupMissing.has(f.name));
  const regressions = backupHad.filter((f) => currentMissing.has(f.name));

  return {
    backupReport,
    currentReport,
    newIssues,
    fixedIssues,
    regressions,
  };
}

// ============================================================================
// Built-in Extractor Registration
// ============================================================================

// Register built-in extractors
// These are always available but only active when their language is enabled in config

registerExtractor('.rs', 'rust', extractRustFacts);
registerExtractor('.ts', 'typescript', extractTypeScriptFacts);
registerExtractor('.tsx', 'typescript', extractTypeScriptFacts);
