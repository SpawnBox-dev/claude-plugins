/**
 * Frontmatter Schema Definition
 *
 * This module defines the complete frontmatter schema for the AI-optimized
 * documentation system. It provides validation, field definitions, and
 * template generation support.
 *
 * ARCHITECTURE PHILOSOPHY (2026-01-07 Refactor):
 * This module now provides INFORMATION, not JUDGMENTS.
 * - Validation reports what's present vs schema expectations
 * - No semantic equivalence matching (LLM handles "Gotchas" vs "Best Practices")
 * - Scores kept for backward compatibility; LLM makes quality decisions
 *
 * CONFIGURABLE: Schema requirements are loaded from config.ts
 * Different presets can have different strictness levels:
 * - DEFAULT_SCHEMA_CONFIG: Minimal requirements for broad compatibility
 * - STRICT_SCHEMA_CONFIG: Full AI-optimized requirements
 *
 * Projects can override via docs-manager.config.json
 */

import { getSchemaConfig, hasExactSection, extractSections, type SchemaConfig } from './config.js';

// ============================================================================
// Field Definitions
// ============================================================================

export const STATUS_VALUES = ['draft', 'current', 'deprecated', 'historical-investigation', 'proposal'] as const;
export type StatusValue = typeof STATUS_VALUES[number];

export const CONFIDENCE_VALUES = ['high', 'medium', 'low', 'unverified', 'n/a'] as const;
export type ConfidenceValue = typeof CONFIDENCE_VALUES[number];

export const VERIFICATION_METHODS = ['code-review', 'runtime-test', 'manual-test', 'unverified'] as const;
export type VerificationMethod = typeof VERIFICATION_METHODS[number];

export const DOC_TYPES = ['backend', 'frontend', 'api', 'database', 'datapack', 'guide', 'architecture', 'meta'] as const;
export type DocType = typeof DOC_TYPES[number];

// ============================================================================
// Frontmatter Schema
// ============================================================================

export interface FrontmatterSchema {
  // === IDENTITY (Required) ===
  title: string;
  'doc-id': string;
  aliases?: string[];

  // === STATUS & TRUST (Required) ===
  status: StatusValue;
  confidence: ConfidenceValue;
  'last-verified': string; // YYYY-MM-DD
  'verification-method': VerificationMethod;

  // === SCOPE (Recommended) ===
  'applies-to'?: {
    component?: string;
    modules?: string[];
    versions?: string;
  }[];

  // === DEPENDENCIES (Required for code docs) ===
  sources?: string[];
  'related-docs'?: string[];
  'depends-on'?: Array<{ 'doc-id': string } | { source: string }>;
  consumes?: Array<{ 'doc-id': string }>;
  prerequisites?: string[];

  // === DISCOVERABILITY (Required) ===
  tags: string[];
  keywords: string[];
  'ai-summary': string;

  // === HISTORY (Required) ===
  created: string; // YYYY-MM-DD
  'original-file'?: string;
  'major-revisions'?: Array<{
    date: string;
    change: string;
  }>;
}

// ============================================================================
// Required Fields by Document Type
// ============================================================================

export const REQUIRED_FIELDS_BASE = [
  'title',
  'doc-id',
  'status',
  'confidence',
  'last-verified',
  'verification-method',
  'tags',
  'keywords',
  'ai-summary',
  'created',
] as const;

export const REQUIRED_FIELDS_CODE_DOC = [
  ...REQUIRED_FIELDS_BASE,
  'sources',
] as const;

export const RECOMMENDED_FIELDS = [
  'applies-to',
  'related-docs',
  'major-revisions',
  'aliases',
] as const;

// NEW: Fields that should be present for cross-linking
export const CROSS_LINKING_FIELDS = [
  'depends-on',
  'prerequisites',
  'consumes',
] as const;

// ============================================================================
// Body Section Requirements (Configurable)
// ============================================================================

// These are kept for backward compatibility but now delegate to config
// Projects can customize via their preset or docs-manager.config.json

/**
 * Get required HTML comments from config
 */
export function getRequiredHtmlComments(): readonly string[] {
  return getSchemaConfig().requiredHtmlComments;
}

/**
 * Get required sections from config
 */
export function getRequiredSections(): readonly string[] {
  return getSchemaConfig().requiredSections;
}

/**
 * Get recommended sections from config
 */
export function getRecommendedSections(): readonly string[] {
  return getSchemaConfig().recommendedSections;
}

// Legacy exports for backward compatibility (use getters above for new code)
// Note: 'Quick Reference' removed from REQUIRED_SECTIONS - it's enforced via requireQuickReference
// flag which checks for the blockquote format (> **Quick Reference**: ...) instead
export const REQUIRED_HTML_COMMENTS = ['AI-CONTEXT', 'TRUST-LEVEL', 'SCOPE'] as const;
export const REQUIRED_SECTIONS = ['Overview', 'History', 'Verification Notes'] as const;
export const RECOMMENDED_SECTIONS = ['Architecture', 'API Reference', 'Usage Examples', 'Gotchas & Edge Cases', 'Related Documentation'] as const;

// Type-specific sections - these help guide what each doc type needs
// but enforcement is based on config.schema settings
export const TYPE_SPECIFIC_SECTIONS: Record<string, string[]> = {
  backend: ['Core Principles', 'System Components & Data Structures', 'Developer Guide'],
  frontend: ['Component Hierarchy', 'Props & State'],
  api: ['Endpoints', 'Error Handling'],
  database: ['Schema', 'Query Examples'],
  guide: ['Prerequisites', 'Steps'],
  architecture: ['System Context', 'Components', 'Data Flow'],
};

// ============================================================================
// Validation Functions
// ============================================================================

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  score: number; // 0-100
}

export interface ValidationError {
  field: string;
  message: string;
  suggestion?: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

/**
 * Validates frontmatter against the schema
 * ENHANCED: Now includes stricter validation for discoverability
 */
export function validateFrontmatter(frontmatter: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  let score = 100;

  // Check required fields
  for (const field of REQUIRED_FIELDS_BASE) {
    if (frontmatter[field] === undefined || frontmatter[field] === null || frontmatter[field] === '') {
      errors.push({
        field,
        message: `Missing required field: ${field}`,
        suggestion: getFieldSuggestion(field),
      });
      score -= 10;
    }
  }

  // Validate status value
  if (frontmatter.status && !STATUS_VALUES.includes(frontmatter.status as StatusValue)) {
    errors.push({
      field: 'status',
      message: `Invalid status value: ${frontmatter.status}`,
      suggestion: `Must be one of: ${STATUS_VALUES.join(', ')}`,
    });
    score -= 5;
  }

  // Validate confidence value
  if (frontmatter.confidence && !CONFIDENCE_VALUES.includes(frontmatter.confidence as ConfidenceValue)) {
    errors.push({
      field: 'confidence',
      message: `Invalid confidence value: ${frontmatter.confidence}`,
      suggestion: `Must be one of: ${CONFIDENCE_VALUES.join(', ')}`,
    });
    score -= 5;
  }

  // Validate verification-method value
  if (frontmatter['verification-method'] && !VERIFICATION_METHODS.includes(frontmatter['verification-method'] as VerificationMethod)) {
    errors.push({
      field: 'verification-method',
      message: `Invalid verification-method value: ${frontmatter['verification-method']}`,
      suggestion: `Must be one of: ${VERIFICATION_METHODS.join(', ')}`,
    });
    score -= 5;
  }

  // Validate date formats
  const dateFields = ['last-verified', 'created'];
  for (const field of dateFields) {
    if (frontmatter[field] && !isValidDate(frontmatter[field] as string)) {
      errors.push({
        field,
        message: `Invalid date format for ${field}: ${frontmatter[field]}`,
        suggestion: 'Use YYYY-MM-DD format (e.g., 2026-01-06)',
      });
      score -= 5;
    }
  }

  // Validate doc-id format
  if (frontmatter['doc-id'] && !isValidDocId(frontmatter['doc-id'] as string)) {
    errors.push({
      field: 'doc-id',
      message: `Invalid doc-id format: ${frontmatter['doc-id']}`,
      suggestion: 'Use lowercase-kebab-case (e.g., backend-event-bus)',
    });
    score -= 5;
  }

  // Check recommended fields
  for (const field of RECOMMENDED_FIELDS) {
    if (frontmatter[field] === undefined) {
      warnings.push({
        field,
        message: `Missing recommended field: ${field}`,
        suggestion: getFieldSuggestion(field),
      });
      score -= 2;
    }
  }

  // Validate arrays are actually arrays
  const arrayFields = ['tags', 'keywords', 'sources', 'related-docs', 'aliases'];
  for (const field of arrayFields) {
    if (frontmatter[field] !== undefined && !Array.isArray(frontmatter[field])) {
      errors.push({
        field,
        message: `${field} must be an array`,
        suggestion: `Use YAML array syntax: ${field}:\n  - item1\n  - item2`,
      });
      score -= 5;
    }
  }

  // ========== ENHANCED VALIDATION ==========

  // Check ai-summary is substantial (100+ chars)
  if (frontmatter['ai-summary'] && typeof frontmatter['ai-summary'] === 'string') {
    const summary = frontmatter['ai-summary'] as string;
    if (summary.length < 100) {
      warnings.push({
        field: 'ai-summary',
        message: 'ai-summary seems too short (< 100 chars)',
        suggestion: 'AI summary should be 3-5 sentences explaining what, when, and why. This is critical for AI discoverability.',
      });
      score -= 3;
    }
    if (summary.includes('TODO') || summary.includes('[Sentence')) {
      warnings.push({
        field: 'ai-summary',
        message: 'ai-summary contains TODO or placeholder text',
        suggestion: 'Replace placeholder text with actual summary content',
      });
      score -= 5;
    }
  }

  // Check tags has at least 2 items
  if (Array.isArray(frontmatter.tags)) {
    if (frontmatter.tags.length === 0) {
      warnings.push({
        field: 'tags',
        message: 'tags array is empty',
        suggestion: 'Add category tags like: backend, frontend, api, database',
      });
      score -= 2;
    } else if (frontmatter.tags.length < 2) {
      warnings.push({
        field: 'tags',
        message: 'tags array has only 1 item (recommend 2+)',
        suggestion: 'Add more category tags for better discoverability',
      });
      score -= 1;
    }
  }

  // NEW: Check keywords has at least 5 items for good discoverability
  if (Array.isArray(frontmatter.keywords)) {
    if (frontmatter.keywords.length === 0) {
      warnings.push({
        field: 'keywords',
        message: 'keywords array is empty',
        suggestion: 'Add search terms someone would use to find this doc',
      });
      score -= 2;
    } else if (frontmatter.keywords.length < 5) {
      warnings.push({
        field: 'keywords',
        message: `keywords array has only ${frontmatter.keywords.length} items (recommend 5+)`,
        suggestion: 'Add more search terms: function names, concepts, related terms. Good docs have 8-15 keywords.',
      });
      score -= 2;
    }
  }

  // NEW: Check for cross-linking fields (depends-on, related-docs)
  const hasRelatedDocs = Array.isArray(frontmatter['related-docs']) && frontmatter['related-docs'].length > 0;
  const hasDependsOn = Array.isArray(frontmatter['depends-on']) && frontmatter['depends-on'].length > 0;
  const hasPrerequisites = Array.isArray(frontmatter.prerequisites) && frontmatter.prerequisites.length > 0;

  if (!hasRelatedDocs && !hasDependsOn && !hasPrerequisites) {
    warnings.push({
      field: 'cross-linking',
      message: 'No cross-references found (related-docs, depends-on, or prerequisites)',
      suggestion: 'Add at least one cross-reference to help readers navigate. Most docs should link to related docs.',
    });
    score -= 3;
  }

  // NEW: Check aliases for discoverability
  if (!Array.isArray(frontmatter.aliases) || frontmatter.aliases.length === 0) {
    warnings.push({
      field: 'aliases',
      message: 'No aliases defined',
      suggestion: 'Add 2-3 alternative names people might search for (abbreviations, alternate spellings)',
    });
    score -= 1;
  }

  // NEW: Validate sources paths look reasonable
  if (Array.isArray(frontmatter.sources)) {
    for (const source of frontmatter.sources) {
      if (typeof source === 'string' && source.includes('TODO')) {
        warnings.push({
          field: 'sources',
          message: `Source path contains TODO: ${source}`,
          suggestion: 'Replace with actual source file path',
        });
        score -= 2;
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    score: Math.max(0, score),
  };
}

/**
 * Validates the body structure of a document
 *
 * 2026-01-07 REFACTOR: Simplified to use exact section matching only.
 * The calling LLM handles semantic equivalence (e.g., "Best Practices" vs "Gotchas").
 * This function reports what's present vs schema expectations.
 */
export function validateBody(content: string, docType?: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  let score = 100;

  // Get configurable schema settings
  const schemaConfig = getSchemaConfig();

  // Extract all sections for reporting
  const allSections = extractSections(content);

  // Check for required HTML comments (from config)
  for (const comment of schemaConfig.requiredHtmlComments) {
    if (!content.includes(`<!-- ${comment}:`)) {
      errors.push({
        field: 'body',
        message: `Missing HTML comment: <!-- ${comment}: ... -->`,
        suggestion: getHtmlCommentSuggestion(comment),
      });
      score -= 5;
    }
  }

  // Check for Quick Reference blockquote (if required by config)
  if (schemaConfig.requireQuickReference && !content.includes('> **Quick Reference**')) {
    errors.push({
      field: 'body',
      message: 'Missing Quick Reference blockquote after title',
      suggestion: '> **Quick Reference**: One-paragraph summary...',
    });
    score -= 5;
  }

  // Check for required sections (from config)
  // NOTE: We now use exact matching only. The LLM calling this tool handles
  // semantic equivalence (e.g., "Best Practices" vs "Gotchas & Edge Cases")
  for (const section of schemaConfig.requiredSections) {
    if (!hasExactSection(content, `## ${section}`)) {
      errors.push({
        field: 'body',
        message: `Missing required section: ## ${section}`,
        suggestion: `Add ## ${section} section (or equivalent - LLM will judge)`,
      });
      score -= 5;
    }
  }

  // Check for recommended sections (from config)
  // NOTE: Removed redundantSectionsByDocType logic - LLM handles context
  for (const section of schemaConfig.recommendedSections) {
    if (!hasExactSection(content, `## ${section}`)) {
      warnings.push({
        field: 'body',
        message: `Missing recommended section: ## ${section}`,
        suggestion: `Consider adding ## ${section} section if applicable`,
      });
      score -= 2;
    }
  }

  // NOTE: Removed TYPE_SPECIFIC_SECTIONS checking - LLM handles based on context

  // Check Verification Notes format (if strict mode enabled)
  if (schemaConfig.requireVerificationNotesFormat && content.includes('## Verification Notes')) {
    if (!content.includes('**Last verified**:')) {
      warnings.push({
        field: 'body',
        message: 'Verification Notes section missing "**Last verified**:" line',
        suggestion: 'Add: **Last verified**: YYYY-MM-DD',
      });
      score -= 2;
    }
    if (!content.includes('**Method**:')) {
      warnings.push({
        field: 'body',
        message: 'Verification Notes section missing "**Method**:" line',
        suggestion: 'Add: **Method**: code-review / runtime-test / manual-test',
      });
      score -= 2;
    }
    if (!content.includes('**Verified items:**')) {
      warnings.push({
        field: 'body',
        message: 'Verification Notes section missing "**Verified items:**" list',
        suggestion: 'Add: **Verified items:**\n- Item 1\n- Item 2',
      });
      score -= 1;
    }
    if (!content.includes('**If you suspect drift:**')) {
      warnings.push({
        field: 'body',
        message: 'Verification Notes section missing "**If you suspect drift:**" instructions',
        suggestion: 'Add drift-checking instructions for future maintainers',
      });
      score -= 1;
    }
  }

  // Check History section format (if strict mode enabled)
  if (schemaConfig.requireHistoryFormat) {
    const historyMatch = content.match(/## History(?!:)[\s\S]*?(?=\n## |$)/);
    if (historyMatch) {
      const historyContent = historyMatch[0];
      if (!historyContent.match(/### \d{4}-\d{2}-\d{2}:/)) {
        warnings.push({
          field: 'body',
          message: 'History section should use "### YYYY-MM-DD: Title" format',
          suggestion: '### 2026-01-06: Initial documentation\n- What changed',
        });
        score -= 2;
      }
    }
  }

  // Report structural elements (informational, not judgmental)
  const hasMermaid = content.includes('```mermaid');
  const todoCount = (content.match(/TODO/g) || []).length;
  const hasCodeBlocks = content.includes('```rust') || content.includes('```typescript') ||
                        content.includes('```tsx') || content.includes('```sql') ||
                        content.includes('```toml') || content.includes('```bash');

  // TODO count affects score (this is deterministic, not semantic)
  if (todoCount > 5) {
    warnings.push({
      field: 'body',
      message: `Document contains ${todoCount} TODO placeholders`,
      suggestion: 'Complete the TODO sections before marking as verified',
    });
    score -= Math.min(10, todoCount);
  } else if (todoCount > 0) {
    warnings.push({
      field: 'body',
      message: `Document contains ${todoCount} TODO placeholder(s)`,
      suggestion: 'Consider completing TODO sections',
    });
    score -= todoCount;
  }

  // NOTE: Removed prescriptive warnings about Mermaid diagrams and code examples.
  // LLM should decide if these are needed based on doc context.

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    score: Math.max(0, score),
  };
}

/**
 * Infer document type from frontmatter tags
 */
export function inferDocType(frontmatter: Record<string, unknown>): string | undefined {
  const tags = frontmatter.tags as string[] | undefined;
  if (!tags || !Array.isArray(tags)) return undefined;

  for (const tag of tags) {
    if (DOC_TYPES.includes(tag as DocType)) {
      return tag;
    }
  }
  return undefined;
}

// ============================================================================
// Helper Functions
// ============================================================================

function isValidDate(dateStr: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) return false;
  const date = new Date(dateStr);
  return !isNaN(date.getTime());
}

function isValidDocId(docId: string): boolean {
  const docIdRegex = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
  return docIdRegex.test(docId);
}

function getFieldSuggestion(field: string): string {
  const suggestions: Record<string, string> = {
    'title': 'Add a descriptive title for the document',
    'doc-id': 'Use lowercase-kebab-case (e.g., backend-event-bus). This ID never changes.',
    'status': 'Set to: current, draft, deprecated, proposal, or historical-investigation',
    'confidence': 'Set to: high, medium, low, unverified, or n/a',
    'last-verified': 'Use today\'s date in YYYY-MM-DD format',
    'verification-method': 'Set to: code-review, runtime-test, manual-test, or unverified',
    'tags': 'Add category tags: backend, frontend, api, database, etc.',
    'keywords': 'Add 5-15 search terms for discoverability (function names, concepts, related terms)',
    'ai-summary': 'Write 3-5 sentences explaining what this is and when to use it. This is critical for AI discovery.',
    'created': 'The date this document was originally created (YYYY-MM-DD)',
    'applies-to': 'Specify which components/modules this doc covers',
    'related-docs': 'List paths to related documentation files',
    'major-revisions': 'Track significant changes with date and description',
    'aliases': 'Add 2-3 alternate names for search (abbreviations, alternate spellings)',
    'sources': 'List the source files this documentation covers',
    'depends-on': 'List doc-ids of documents this one requires understanding',
    'prerequisites': 'List docs that should be read BEFORE this one',
  };
  return suggestions[field] || `Add the ${field} field`;
}

function getHtmlCommentSuggestion(comment: string): string {
  const suggestions: Record<string, string> = {
    'AI-CONTEXT': '<!-- AI-CONTEXT: One-line description of what this doc covers -->',
    'TRUST-LEVEL': '<!-- TRUST-LEVEL: High - Verified against code YYYY-MM-DD -->',
    'SCOPE': '<!-- SCOPE: Covers X, Y, Z. Does NOT cover A, B. -->',
  };
  return suggestions[comment] || `<!-- ${comment}: ... -->`;
}

// ============================================================================
// Fix Generation
// ============================================================================

export interface SuggestedFix {
  location: 'frontmatter' | 'after-frontmatter' | 'after-title' | 'end-of-doc';
  field?: string;
  action: 'add' | 'replace';
  content: string;
  description: string;
}

/**
 * Generate suggested fixes for validation errors/warnings
 * Returns actual content that can be inserted/replaced
 */
export function generateFixes(
  content: string,
  frontmatter: Record<string, unknown>,
  validationResult: ValidationResult
): SuggestedFix[] {
  const fixes: SuggestedFix[] = [];
  const today = new Date().toISOString().split('T')[0];
  const title = (frontmatter.title as string) || 'Document';
  const sources = (frontmatter.sources as string[]) || [];

  // Track which fixes we've already added to avoid duplicates
  const addedFixes = new Set<string>();

  // Process errors and warnings
  const allIssues = [...validationResult.errors, ...validationResult.warnings];

  for (const issue of allIssues) {
    // Missing frontmatter fields
    if (issue.field === 'created' && issue.message.includes('Missing') && !addedFixes.has('created')) {
      addedFixes.add('created');
      fixes.push({
        location: 'frontmatter',
        field: 'created',
        action: 'add',
        content: `created: ${today}`,
        description: 'Add creation date',
      });
    }

    // Handle both "Missing recommended field: aliases" and "No aliases defined"
    if ((issue.field === 'aliases' && !addedFixes.has('aliases'))) {
      addedFixes.add('aliases');
      const slug = title.toLowerCase().replace(/\s+/g, '-');
      fixes.push({
        location: 'frontmatter',
        field: 'aliases',
        action: 'add',
        content: `aliases:\n  - ${slug}`,
        description: 'Add search aliases',
      });
    }

    if (issue.field === 'applies-to' && issue.message.includes('Missing') && !addedFixes.has('applies-to')) {
      addedFixes.add('applies-to');
      fixes.push({
        location: 'frontmatter',
        field: 'applies-to',
        action: 'add',
        content: `applies-to:\n  - component: TODO\n    modules:\n      - ${sources[0] || 'TODO'}`,
        description: 'Add scope definition',
      });
    }

    // Handle both "Missing recommended field: related-docs" and "No cross-references found"
    if ((issue.field === 'related-docs' || issue.field === 'cross-linking') && !addedFixes.has('related-docs')) {
      addedFixes.add('related-docs');
      fixes.push({
        location: 'frontmatter',
        field: 'related-docs',
        action: 'add',
        content: `related-docs:\n  - docs/backend/README.md  # Add related doc paths`,
        description: 'Add related documentation links',
      });
    }

    if (issue.field === 'major-revisions' && issue.message.includes('Missing') && !addedFixes.has('major-revisions')) {
      addedFixes.add('major-revisions');
      fixes.push({
        location: 'frontmatter',
        field: 'major-revisions',
        action: 'add',
        content: `major-revisions:\n  - date: ${today}\n    change: Initial documentation`,
        description: 'Add revision history in frontmatter',
      });
    }

    // Missing HTML comments (after frontmatter)
    if (issue.message.includes('Missing HTML comment: <!-- AI-CONTEXT') && !addedFixes.has('AI-CONTEXT')) {
      addedFixes.add('AI-CONTEXT');
      // Generate a smarter AI-CONTEXT based on title and sources
      let contextHint = title;
      if (sources.length > 0) {
        // Extract the module/component name from the first source path
        const firstSource = sources[0];
        const pathParts = firstSource.split('/');
        const fileName = pathParts[pathParts.length - 1];
        const moduleName = fileName.replace(/\.(rs|ts|tsx|js|py)$/, '');
        if (moduleName && moduleName !== fileName) {
          contextHint = `${title} - ${moduleName} module`;
        }
      }
      fixes.push({
        location: 'after-frontmatter',
        action: 'add',
        content: `<!-- AI-CONTEXT: ${contextHint} -->`,
        description: 'Add AI context comment',
      });
    }

    if (issue.message.includes('Missing HTML comment: <!-- TRUST-LEVEL') && !addedFixes.has('TRUST-LEVEL')) {
      addedFixes.add('TRUST-LEVEL');
      fixes.push({
        location: 'after-frontmatter',
        action: 'add',
        content: `<!-- TRUST-LEVEL: High - Verified against code ${today} -->`,
        description: 'Add trust level comment',
      });
    }

    if (issue.message.includes('Missing HTML comment: <!-- SCOPE') && !addedFixes.has('SCOPE')) {
      addedFixes.add('SCOPE');
      fixes.push({
        location: 'after-frontmatter',
        action: 'add',
        content: `<!-- SCOPE: Covers ${sources.join(', ') || 'TODO'}. Does NOT cover [TODO]. -->`,
        description: 'Add scope comment',
      });
    }

    // Missing Quick Reference (after title) - either as blockquote or section
    if ((issue.message.includes('Missing Quick Reference blockquote') ||
         issue.message.includes('Missing required section: ## Quick Reference')) &&
        !addedFixes.has('Quick Reference')) {
      addedFixes.add('Quick Reference');

      // Build a more helpful Quick Reference using available frontmatter info
      let quickRefContent = '> **Quick Reference**: ';

      if (sources.length > 0) {
        // Use the first source as entry point
        quickRefContent += `Entry point is \`${sources[0]}\`. `;

        // If there are multiple sources, mention them
        if (sources.length > 1) {
          quickRefContent += `Also covers: ${sources.slice(1).map(s => `\`${s}\``).join(', ')}. `;
        }
      }

      // Add a placeholder for what to do with this doc
      quickRefContent += `Use this for understanding ${title.toLowerCase()}.`;

      fixes.push({
        location: 'after-title',
        action: 'add',
        content: quickRefContent,
        description: 'Add Quick Reference blockquote',
      });
    }

    // Missing sections (end of doc)
    if (issue.message.includes('Missing required section: ## Verification Notes') && !addedFixes.has('Verification Notes')) {
      addedFixes.add('Verification Notes');
      fixes.push({
        location: 'end-of-doc',
        action: 'add',
        content: `## Verification Notes

**Last verified**: ${today}
**Method**: code-review

**Verified items:**
- TODO: List verified items

**If you suspect drift:**
1. Check source files listed in frontmatter
2. Compare documented signatures to actual code`,
        description: 'Add Verification Notes section',
      });
    }

    if (issue.message.includes('Missing required section: ## History') && !content.includes('## History') && !addedFixes.has('History')) {
      addedFixes.add('History');
      fixes.push({
        location: 'end-of-doc',
        action: 'add',
        content: `## History

### ${today}: Documentation review
- Verified against source code
- Updated to current standard`,
        description: 'Add History section',
      });
    }
  }

  return fixes;
}

/**
 * Apply fixes to document content
 * Returns the modified content
 */
export function applyFixes(content: string, fixes: SuggestedFix[]): string {
  let result = content;

  // Sort fixes by location priority
  const frontmatterFixes = fixes.filter(f => f.location === 'frontmatter');
  const afterFrontmatterFixes = fixes.filter(f => f.location === 'after-frontmatter');
  const afterTitleFixes = fixes.filter(f => f.location === 'after-title');
  const endFixes = fixes.filter(f => f.location === 'end-of-doc');

  // Apply frontmatter fixes (insert before closing ---)
  if (frontmatterFixes.length > 0) {
    const frontmatterEnd = result.indexOf('---', result.indexOf('---') + 3);
    if (frontmatterEnd > 0) {
      const insertContent = frontmatterFixes.map(f => f.content).join('\n');
      result = result.slice(0, frontmatterEnd) + insertContent + '\n' + result.slice(frontmatterEnd);
    }
  }

  // Apply after-frontmatter fixes (insert after closing ---)
  if (afterFrontmatterFixes.length > 0) {
    const frontmatterEnd = result.indexOf('---', result.indexOf('---') + 3);
    if (frontmatterEnd > 0) {
      const insertPos = frontmatterEnd + 3;
      const insertContent = '\n\n' + afterFrontmatterFixes.map(f => f.content).join('\n');
      result = result.slice(0, insertPos) + insertContent + result.slice(insertPos);
    }
  }

  // Apply after-title fixes (insert after # Title line)
  if (afterTitleFixes.length > 0) {
    const titleMatch = result.match(/^# .+$/m);
    if (titleMatch && titleMatch.index !== undefined) {
      const insertPos = titleMatch.index + titleMatch[0].length;
      const insertContent = '\n\n' + afterTitleFixes.map(f => f.content).join('\n');
      result = result.slice(0, insertPos) + insertContent + result.slice(insertPos);
    }
  }

  // Apply end-of-doc fixes
  if (endFixes.length > 0) {
    const insertContent = '\n\n' + endFixes.map(f => f.content).join('\n\n');
    result = result.trimEnd() + insertContent + '\n';
  }

  return result;
}

// ============================================================================
// Exports
// ============================================================================

export const SCHEMA = {
  STATUS_VALUES,
  CONFIDENCE_VALUES,
  VERIFICATION_METHODS,
  DOC_TYPES,
  REQUIRED_FIELDS_BASE,
  REQUIRED_FIELDS_CODE_DOC,
  RECOMMENDED_FIELDS,
  CROSS_LINKING_FIELDS,
  REQUIRED_HTML_COMMENTS,
  REQUIRED_SECTIONS,
  RECOMMENDED_SECTIONS,
  TYPE_SPECIFIC_SECTIONS,
};
