#!/usr/bin/env node
/**
 * Documentation Manager MCP Server
 *
 * ARCHITECTURE PHILOSOPHY (2026-01-07 Refactor):
 * This MCP provides INFORMATION and OPERATIONS, not JUDGMENTS.
 * - Extract: Document structure, source facts, file metadata
 * - Calculate: Staleness based on git dates (deterministic)
 * - Execute: Backups, archive, index updates (file operations)
 * - Provide: Schema definitions, templates, guidance
 *
 * The calling LLM handles semantic judgments:
 * - Is this section equivalent to another? (LLM decides)
 * - Is this doc "good enough"? (LLM decides)
 * - What doc type is this? (LLM weighs signals from MCP)
 *
 * Tools provided:
 * - Schema validation (reports presence vs expectations)
 * - Staleness calculation and trust badges
 * - Template generation (full docs, frontmatter, diagrams)
 * - Index.md management
 * - Backup operations
 * - Archive management
 *
 * Standard defined in: docs/meta/2026-01-06-documentation-standard.md
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

// Import our modules
import {
  validateFrontmatter,
  validateBody,
  generateFixes,
  SCHEMA,
  type ValidationResult,
  type SuggestedFix,
} from './schema.js';
import {
  calculateStaleness,
  scanAllDocs,
  generateStalenessReport,
  type StalenessResult,
} from './staleness.js';
import {
  generateDocument,
  generateFrontmatter,
  generateHtmlComments,
  generateQuickReference,
  generateHistoryEntry,
  generateVerificationNotes,
  generateDataFlowDiagram,
  generateArchitectureDiagram,
  generateStateDiagram,
  generateSequenceDiagram,
  generateSourceMapEntry,
  generateCategoryEntry,
  generateRedirectEntry,
  generateArchiveEntry,
  suggestDocId,
  generateFilename,
  getSectionRecommendations,
  generateExemplaryTemplate,
  type DocType,
  type TemplateConfig,
  type SectionRecommendation,
} from './templates.js';
import {
  generateIndexAdditions,
  generateMoveEdits,
  generateArchiveEdits,
  generateStalenessUpdates,
  describeIndexEdits,
  applyAndSaveIndex,
  reconcileIndex,
  formatReconciliationReport,
  type IndexEdit,
  type ApplyResult,
  type ReconciliationResult,
} from './index-manager.js';
import {
  backupFileBeforeEdit,
  createSnapshot,
  restoreFromBackup,
  listBackups,
  cleanupOldBackups,
} from './backup.js';
import {
  extractRustFacts,
  verifyDocAgainstFacts,
  generateVerificationReport,
  generateEditSuggestions,
  compareBackupToSource,
  extractTypeScriptFacts,
  type SourceFact,
  type SourceVerificationReport,
} from './source-verification.js';
import {
  archiveDocument,
  restoreFromArchive,
  listArchived,
  suggestArchiveCandidates,
  type ArchiveReason,
} from './archive.js';
import {
  getVerificationStrategy,
  getStrategyExplanation,
  getDocTypeGuidance,
  runConceptualChecks,
  formatConceptualReport,
  getAvailableDocTypes,
  type VerificationStrategy,
} from './conceptual-checks.js';
import {
  loadConfig,
  getProjectRoot,
  getDocsRoot,
  inferDocTypeFromPath,
  inferDocTypeFromTags,
  isGuideDocument,
  type DocsManagerConfig,
} from './config.js';
import { extractFacts, getSupportedExtensions } from './source-verification.js';
import {
  analyzePlacement,
  findOverlaps,
  analyzeHealth,
  generateReorganizationReport,
  moveDocFile,
  deleteDocFile,
  mergeDocFiles,
  type PlacementAnalysis,
  type OverlapAnalysis,
  type DocHealthSignal,
  type ReorganizationReport,
} from './reorganization.js';

// ============================================================================
// Configuration
// ============================================================================

// Config is loaded lazily via getDocsRoot() and getProjectRoot()
// These getter functions use the config system which auto-detects project type

// For backward compatibility, also support these variables being set directly
let DOCS_ROOT = '';
let PROJECT_ROOT = '';

function getEffectiveDocsRoot(): string {
  return DOCS_ROOT || getDocsRoot();
}

function getEffectiveProjectRoot(): string {
  return PROJECT_ROOT || getProjectRoot();
}

// ============================================================================
// Helper Functions
// ============================================================================

function parseFrontmatter(content: string): Record<string, unknown> | null {
  // Handle both Unix (LF) and Windows (CRLF) line endings
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  try {
    return yaml.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function parseDocFile(
  filePath: string
): Promise<{ lastVerified?: string; sources?: string[]; verificationMethod?: string } | null> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    if (!fm) return null;

    return {
      lastVerified: fm['last-verified'] as string | undefined,
      sources: fm.sources as string[] | undefined,
      verificationMethod: fm['verification-method'] as string | undefined,
    };
  } catch {
    return null;
  }
}

function formatValidationResult(result: ValidationResult): string {
  let output = `## Validation Result\n\n`;
  output += `**Valid:** ${result.isValid ? '✅ Yes' : '❌ No'}\n`;
  output += `**Score:** ${result.score}/100\n\n`;

  if (result.errors.length > 0) {
    output += `### Errors (${result.errors.length})\n\n`;
    for (const error of result.errors) {
      output += `- **${error.field}**: ${error.message}\n`;
      if (error.suggestion) {
        output += `  - 💡 ${error.suggestion}\n`;
      }
    }
    output += '\n';
  }

  if (result.warnings.length > 0) {
    output += `### Warnings (${result.warnings.length})\n\n`;
    for (const warning of result.warnings) {
      output += `- **${warning.field}**: ${warning.message}\n`;
      if (warning.suggestion) {
        output += `  - 💡 ${warning.suggestion}\n`;
      }
    }
  }

  return output;
}

function formatSuggestedFixes(fixes: SuggestedFix[]): string {
  if (fixes.length === 0) return '';

  let output = '\n---\n\n## Suggested Fixes\n\n';
  output += 'Copy and paste these fixes to resolve the issues:\n\n';

  // Group fixes by location
  const byLocation: Record<string, SuggestedFix[]> = {};
  for (const fix of fixes) {
    if (!byLocation[fix.location]) byLocation[fix.location] = [];
    byLocation[fix.location].push(fix);
  }

  // Order: frontmatter -> after-frontmatter -> after-title -> end-of-doc
  const locationOrder = ['frontmatter', 'after-frontmatter', 'after-title', 'end-of-doc'];
  const locationLabels: Record<string, string> = {
    'frontmatter': 'Add to Frontmatter (before closing `---`)',
    'after-frontmatter': 'Add After Frontmatter (after closing `---`)',
    'after-title': 'Add After Title (after `# Title`)',
    'end-of-doc': 'Add at End of Document',
  };

  for (const location of locationOrder) {
    const locationFixes = byLocation[location];
    if (!locationFixes || locationFixes.length === 0) continue;

    output += `### ${locationLabels[location]}\n\n`;
    for (const fix of locationFixes) {
      output += `**${fix.description}:**\n`;
      output += '```yaml\n';
      output += fix.content;
      output += '\n```\n\n';
    }
  }

  return output;
}

function formatStalenessResult(docPath: string, result: StalenessResult): string {
  let output = `## Staleness Analysis: ${docPath}\n\n`;
  output += `**Badge:** ${result.badgeEmoji} ${result.badge}\n`;
  output += `**Priority:** ${result.priority}\n`;
  output += `**Summary:** ${result.summary}\n\n`;

  if (result.daysSinceVerification !== null) {
    output += `**Days since verification:** ${result.daysSinceVerification}\n`;
  }

  if (result.staleSources.length > 0) {
    output += `\n### Stale Sources\n\n`;
    for (const source of result.staleSources) {
      output += `- \`${source.path}\` - modified ${source.daysSinceDocVerification} days after doc verification\n`;
    }
  }

  return output;
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new Server(
  {
    name: 'docs-manager',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ============================================================================
// Resources
// ============================================================================

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'docs://schema/frontmatter',
        name: 'Frontmatter Schema',
        description: 'Complete frontmatter schema definition with all required and recommended fields',
        mimeType: 'application/json',
      },
      {
        uri: 'docs://schema/body',
        name: 'Body Structure Schema',
        description: 'Required HTML comments, sections, and formatting for document bodies',
        mimeType: 'application/json',
      },
      {
        uri: 'docs://templates/full',
        name: 'Full Document Template',
        description: 'Complete document template with all required sections',
        mimeType: 'text/markdown',
      },
      {
        uri: 'docs://templates/exemplary',
        name: 'Exemplary Filled-In Template',
        description: 'A fully filled-in example showing what GOOD documentation looks like. Use this as a reference when creating new docs.',
        mimeType: 'text/markdown',
      },
      {
        uri: 'docs://guide/quick-start',
        name: 'Documentation Quick Start',
        description: 'Quick reference for creating properly formatted docs',
        mimeType: 'text/markdown',
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {
    case 'docs://schema/frontmatter':
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                requiredFields: SCHEMA.REQUIRED_FIELDS_BASE,
                requiredForCodeDocs: SCHEMA.REQUIRED_FIELDS_CODE_DOC,
                recommendedFields: SCHEMA.RECOMMENDED_FIELDS,
                statusValues: SCHEMA.STATUS_VALUES,
                confidenceValues: SCHEMA.CONFIDENCE_VALUES,
                verificationMethods: SCHEMA.VERIFICATION_METHODS,
              },
              null,
              2
            ),
          },
        ],
      };

    case 'docs://schema/body':
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                requiredHtmlComments: SCHEMA.REQUIRED_HTML_COMMENTS,
                requiredSections: SCHEMA.REQUIRED_SECTIONS,
                recommendedSections: SCHEMA.RECOMMENDED_SECTIONS,
              },
              null,
              2
            ),
          },
        ],
      };

    case 'docs://templates/full':
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: generateDocument({
              title: 'Example Document',
              docId: 'example-document',
              sources: ['src/example.rs'],
              type: 'backend',
              aliases: ['example'],
              relatedDocs: ['docs/related.md'],
              component: 'ExampleComponent',
              modules: ['example/*'],
            }),
          },
        ],
      };

    case 'docs://templates/exemplary':
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: generateExemplaryTemplate(),
          },
        ],
      };

    case 'docs://guide/quick-start':
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: `# Documentation Quick Start Guide

## Creating a New Document

1. Use \`docs_generate_template\` tool with your document info
2. Save to appropriate \`docs/\` subfolder with date prefix: \`YYYY-MM-DD-topic.md\`
3. Fill in all TODO placeholders
4. Validate with \`docs_validate\` tool
5. Add to index with \`docs_index_add\` tool

## Required Frontmatter Fields

\`\`\`yaml
---
title: "Document Title"
doc-id: kebab-case-id
status: current | draft | deprecated | proposal
confidence: high | medium | low | unverified
last-verified: YYYY-MM-DD
verification-method: code-review | runtime-test | manual-test
tags: [category1, category2]
keywords: [search, terms]
ai-summary: >
  3-5 sentences explaining what this is, when to use it,
  and key concepts. This is used by AI for discovery.
created: YYYY-MM-DD
sources:
  - path/to/source/file.rs
---
\`\`\`

## Required HTML Comments (after frontmatter)

\`\`\`html
<!-- AI-CONTEXT: One-line description of what this doc covers -->
<!-- TRUST-LEVEL: High | Medium | Low - Brief explanation -->
<!-- SCOPE: Covers X, Y. Does NOT cover A, B. -->
\`\`\`

## Required Sections

1. **Quick Reference** (blockquote after title)
2. **Overview**
3. **History** (with dated entries: ### YYYY-MM-DD: Title)
4. **Verification Notes**

## Trust Badges

- ✅ FRESH: Verified recently, no source changes
- ⚠️ STALE: Source files changed since verification
- ❌ UNVERIFIED: Never verified against code
- 🕐 AGING: Verified 30+ days ago, needs review
`,
          },
        ],
      };

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// ============================================================================
// Tools
// ============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // === VALIDATION TOOLS ===
      {
        name: 'docs_validate',
        description:
          'Validate a documentation file against the schema. Checks frontmatter fields, body structure, HTML comments, and required sections. Returns detailed errors and warnings with suggestions.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the markdown file to validate (relative to docs root)',
            },
            content: {
              type: 'string',
              description: 'Alternative: raw markdown content to validate (instead of filePath)',
            },
          },
        },
      },
      {
        name: 'docs_validate_frontmatter',
        description:
          'Validate only the frontmatter of a document. Useful for quick checks while editing.',
        inputSchema: {
          type: 'object',
          properties: {
            frontmatter: {
              type: 'object',
              description: 'Frontmatter object to validate',
            },
          },
          required: ['frontmatter'],
        },
      },

      // === STALENESS TOOLS ===
      {
        name: 'docs_check_staleness',
        description:
          'Calculate the staleness/trust status of a document. Compares last-verified date against source file modifications using git history.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the markdown file (relative to docs root)',
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'docs_scan_all_staleness',
        description:
          'Scan all documentation files and generate a comprehensive staleness report. Shows which docs are FRESH, STALE, AGING, or UNVERIFIED.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },

      // === TEMPLATE TOOLS ===
      {
        name: 'docs_generate_template',
        description:
          'Generate a complete documentation template with all required frontmatter, HTML comments, and sections. The template follows the AI-optimized documentation standard.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Document title' },
            type: {
              type: 'string',
              enum: ['backend', 'frontend', 'api', 'database', 'datapack', 'guide', 'architecture', 'meta'],
              description: 'Document type/category',
            },
            sources: {
              type: 'array',
              items: { type: 'string' },
              description: 'Source file paths this doc covers',
            },
            aliases: {
              type: 'array',
              items: { type: 'string' },
              description: 'Alternative names for search',
            },
            relatedDocs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Paths to related documentation',
            },
            component: {
              type: 'string',
              description: 'Component name this doc applies to',
            },
            modules: {
              type: 'array',
              items: { type: 'string' },
              description: 'Module paths this doc covers',
            },
          },
          required: ['title', 'type', 'sources'],
        },
      },
      {
        name: 'docs_generate_frontmatter',
        description: 'Generate only the frontmatter section for a document.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            type: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'type', 'sources'],
        },
      },
      {
        name: 'docs_generate_diagram',
        description:
          'Generate a Mermaid diagram for documentation. Supports data flow, architecture, state, and sequence diagrams.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['dataflow', 'architecture', 'state', 'sequence'],
              description: 'Type of diagram to generate',
            },
            data: {
              type: 'object',
              description: 'Diagram-specific data (steps, components, states, or messages)',
            },
          },
          required: ['type', 'data'],
        },
      },
      {
        name: 'docs_suggest_filename',
        description:
          'Generate a properly formatted filename with date prefix for a new document.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Document title' },
          },
          required: ['title'],
        },
      },
      {
        name: 'docs_suggest_sections',
        description:
          'Get recommended sections for a specific document type. Returns required and optional sections with descriptions and examples. Use this to ensure your documentation includes all expected content.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['backend', 'frontend', 'api', 'database', 'datapack', 'guide', 'architecture', 'meta'],
              description: 'Document type to get section recommendations for',
            },
          },
          required: ['type'],
        },
      },

      // === INDEX TOOLS ===
      {
        name: 'docs_index_add',
        description:
          'Generate the index.md entries needed when adding a new document. Returns formatted table rows for Source Map, Category section, and Recently Verified.',
        inputSchema: {
          type: 'object',
          properties: {
            docPath: { type: 'string', description: 'Path to the new doc (relative to docs root)' },
            docTitle: { type: 'string', description: 'Document title' },
            sources: {
              type: 'array',
              items: { type: 'string' },
              description: 'Source files this doc covers',
            },
            category: {
              type: 'string',
              description: 'Category for docs-by-category section (Backend, Frontend, API, etc.)',
            },
          },
          required: ['docPath', 'docTitle', 'sources', 'category'],
        },
      },
      {
        name: 'docs_index_move',
        description:
          'Generate the index.md updates needed when moving/renaming a document. Returns redirect entry and path updates.',
        inputSchema: {
          type: 'object',
          properties: {
            oldPath: { type: 'string', description: 'Original doc path' },
            newPath: { type: 'string', description: 'New doc path' },
            docTitle: { type: 'string', description: 'Document title' },
          },
          required: ['oldPath', 'newPath', 'docTitle'],
        },
      },
      {
        name: 'docs_index_apply',
        description:
          'Atomically apply index.md updates for add/move/archive operations. This actually modifies index.md rather than just generating instructions. Use this for atomic doc+index updates.',
        inputSchema: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['add', 'move', 'archive'],
              description: 'Type of index operation',
            },
            docPath: { type: 'string', description: 'Path to the doc (relative to docs root)' },
            docTitle: { type: 'string', description: 'Document title (required for add)' },
            sources: {
              type: 'array',
              items: { type: 'string' },
              description: 'Source files this doc covers (required for add)',
            },
            category: {
              type: 'string',
              enum: ['Backend', 'Frontend', 'API', 'Database', 'Datapack', 'Guides', 'Architecture', 'Meta'],
              description: 'Category for docs-by-category section (required for add)',
            },
            oldPath: { type: 'string', description: 'Original doc path (required for move)' },
            newPath: { type: 'string', description: 'New doc path (required for move)' },
            archivePath: { type: 'string', description: 'Archive destination path (required for archive)' },
            archiveReason: {
              type: 'string',
              enum: ['obsolete', 'superseded', 'deprecated', 'investigation-complete', 'restructured'],
              description: 'Reason for archiving (required for archive)',
            },
          },
          required: ['operation', 'docPath'],
        },
      },
      {
        name: 'docs_index_reconcile',
        description:
          'Reconcile index.md against the actual docs folder. Finds orphaned docs (in folder but not in index) and stale index entries (point to non-existent docs). Use this to detect sync issues.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },

      // === BACKUP TOOLS ===
      {
        name: 'docs_backup_file',
        description:
          'Create a backup of a document before editing. Automatically called by archive operations.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to file to backup' },
            reason: { type: 'string', description: 'Reason for backup' },
          },
          required: ['filePath', 'reason'],
        },
      },
      {
        name: 'docs_backup_snapshot',
        description:
          'Create a full snapshot backup of the entire docs folder. Use before major reorganizations.',
        inputSchema: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Reason for snapshot' },
          },
          required: ['reason'],
        },
      },
      {
        name: 'docs_backup_list',
        description: 'List all available backups, optionally filtered by type or file.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['snapshot', 'pre-edit', 'pre-archive'],
              description: 'Filter by backup type',
            },
            sourceFile: { type: 'string', description: 'Filter by source filename' },
          },
        },
      },
      {
        name: 'docs_backup_restore',
        description: 'Restore a document from a backup.',
        inputSchema: {
          type: 'object',
          properties: {
            backupPath: { type: 'string', description: 'Path to the backup file' },
            targetPath: {
              type: 'string',
              description: 'Optional: where to restore (defaults to original location)',
            },
          },
          required: ['backupPath'],
        },
      },
      {
        name: 'docs_backup_cleanup',
        description: 'Clean up old backups based on retention policy (default 30 days).',
        inputSchema: {
          type: 'object',
          properties: {
            retentionDays: { type: 'number', description: 'Days to retain backups (default 30)' },
          },
        },
      },

      // === SOURCE VERIFICATION TOOLS ===
      {
        name: 'docs_extract_source_facts',
        description:
          'Extract concrete facts from source files. Supports both Rust (.rs) files (structs, enums, consts, functions) and TypeScript/React (.ts, .tsx) files (interfaces, types, components, hooks, stores). Best for API and database docs that need accurate type information. For architecture/guide docs, focus on conceptual content instead.',
        inputSchema: {
          type: 'object',
          properties: {
            sourcePaths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of source file paths (relative to project root). Supports .rs, .ts, and .tsx files.',
            },
            filterTypes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: Only extract these specific type/interface/component names. Use for large files to focus on relevant items (e.g., ["AppEvent", "EventScope"] for Rust or ["PlayerStore", "useLogStore"] for TypeScript).',
            },
          },
          required: ['sourcePaths'],
        },
      },
      {
        name: 'docs_verify_against_source',
        description:
          'Verify that a documentation file contains the required facts from its source files. Best for api/database docs. For architecture/guide/backend docs, use docs_prepare_update which includes conceptual completeness checks.',
        inputSchema: {
          type: 'object',
          properties: {
            docPath: {
              type: 'string',
              description: 'Path to the documentation file (relative to docs root)',
            },
            sourcePaths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of source file paths to verify against',
            },
            filterTypes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: Only verify these specific type/const/function names. Use for large files to focus on types this doc covers.',
            },
          },
          required: ['docPath', 'sourcePaths'],
        },
      },
      {
        name: 'docs_prepare_update',
        description:
          'Prepare to update a document with doc-type-aware guidance. Creates backup, then runs appropriate checks: source fact verification for api/database docs, conceptual completeness checks for architecture/guide docs, or hybrid for backend/frontend. ALWAYS use this before modifying documentation.',
        inputSchema: {
          type: 'object',
          properties: {
            docPath: {
              type: 'string',
              description: 'Path to the documentation file (relative to docs root)',
            },
            sourcePaths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of source file paths this doc covers',
            },
            filterTypes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: Only verify these specific types from large source files (e.g., ["AppEvent", "EventScope", "EventDetails"] for event-bus doc).',
            },
            reason: {
              type: 'string',
              description: 'Reason for the update (for backup log)',
            },
          },
          required: ['docPath', 'sourcePaths', 'reason'],
        },
      },

      // === ARCHIVE TOOLS ===
      {
        name: 'docs_archive',
        description:
          'Archive a document (move to archive folder, add metadata, update index). Use for deprecated, obsolete, or superseded docs.',
        inputSchema: {
          type: 'object',
          properties: {
            docPath: { type: 'string', description: 'Path to document to archive' },
            reason: {
              type: 'string',
              enum: ['obsolete', 'superseded', 'deprecated', 'investigation-complete', 'restructured'],
              description: 'Reason for archiving',
            },
            supersededBy: {
              type: 'string',
              description: 'Path to replacement doc (if reason is superseded)',
            },
            notes: { type: 'string', description: 'Additional context' },
          },
          required: ['docPath', 'reason'],
        },
      },
      {
        name: 'docs_archive_restore',
        description: 'Restore a document from the archive.',
        inputSchema: {
          type: 'object',
          properties: {
            archivePath: { type: 'string', description: 'Path to archived document' },
            targetPath: {
              type: 'string',
              description: 'Optional: where to restore (defaults to original location)',
            },
          },
          required: ['archivePath'],
        },
      },
      {
        name: 'docs_archive_list',
        description: 'List all archived documents with their metadata.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'docs_archive_suggest',
        description:
          'Suggest documents that might be candidates for archival based on status and staleness.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },

      // === UTILITY TOOLS ===
      {
        name: 'docs_generate_history_entry',
        description:
          'Generate a properly formatted History section entry for a document update.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Brief title of the change' },
            changes: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of changes made',
            },
          },
          required: ['title', 'changes'],
        },
      },
      {
        name: 'docs_generate_verification_notes',
        description:
          'Generate a properly formatted Verification Notes section.',
        inputSchema: {
          type: 'object',
          properties: {
            method: {
              type: 'string',
              enum: ['code-review', 'runtime-test', 'manual-test'],
              description: 'Verification method used',
            },
            verifiedItems: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of items verified',
            },
            driftChecks: {
              type: 'array',
              items: { type: 'string' },
              description: 'Instructions for checking drift',
            },
          },
          required: ['method', 'verifiedItems', 'driftChecks'],
        },
      },

      // === REORGANIZATION TOOLS ===
      {
        name: 'docs_analyze_placement',
        description:
          'Analyze whether docs are in appropriate folders based on their content. Returns signals about potential misplacements. Encourages proper organization - docs should live in folders matching their actual type.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'docs_find_overlaps',
        description:
          'Find documents that may overlap in scope (shared sources or similar titles). Overlapping docs are candidates for consolidation. Encourages gardening - fewer well-maintained docs are better than many partial ones.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'docs_analyze_health',
        description:
          'Analyze documentation health and identify candidates for removal/consolidation. Checks for orphaned docs, small/stub content, unlinked docs, and missing sources. Encourages gardening and cleanup.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'docs_reorganization_report',
        description:
          'Generate a comprehensive documentation reorganization report. Combines placement analysis, overlap detection, and health signals into a single gardening report with actionable insights.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'docs_move_file',
        description:
          'Move a documentation file to a new location. Creates backup, moves file, updates index.md, and reports cross-references that need updating. Use for reorganizing misplaced docs.',
        inputSchema: {
          type: 'object',
          properties: {
            oldPath: { type: 'string', description: 'Current path of the doc (relative to docs root)' },
            newPath: { type: 'string', description: 'New path for the doc (relative to docs root)' },
            updateIndex: {
              type: 'boolean',
              description: 'Whether to update index.md (default true)',
            },
          },
          required: ['oldPath', 'newPath'],
        },
      },
      {
        name: 'docs_delete_file',
        description:
          'Delete a documentation file by archiving it with reason "obsolete". Does not permanently delete - preserves in archive for recovery. Use for removing docs that are no longer needed.',
        inputSchema: {
          type: 'object',
          properties: {
            docPath: { type: 'string', description: 'Path to the doc to delete (relative to docs root)' },
            reason: { type: 'string', description: 'Reason for deletion (for archive notes)' },
          },
          required: ['docPath', 'reason'],
        },
      },
      {
        name: 'docs_merge_files',
        description:
          'Merge multiple docs into one. Creates the merged doc, archives source docs with reason "restructured", and reports cross-references to update. LLM must provide the merged content.',
        inputSchema: {
          type: 'object',
          properties: {
            sourcePaths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Paths to docs being merged (will be archived)',
            },
            targetPath: { type: 'string', description: 'Path for the merged doc' },
            mergedContent: {
              type: 'string',
              description: 'The full content of the merged document (LLM must compose this)',
            },
          },
          required: ['sourcePaths', 'targetPath', 'mergedContent'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // === VALIDATION ===
      case 'docs_validate': {
        let content: string;
        if (args?.content) {
          content = args.content as string;
        } else if (args?.filePath) {
          const fullPath = path.join(getEffectiveDocsRoot(), args.filePath as string);
          content = fs.readFileSync(fullPath, 'utf-8');
        } else {
          throw new Error('Either filePath or content is required');
        }

        const frontmatter = parseFrontmatter(content);
        const fmResult = frontmatter
          ? validateFrontmatter(frontmatter)
          : {
              isValid: false,
              errors: [{ field: 'frontmatter', message: 'No frontmatter found' }],
              warnings: [],
              score: 0,
            };
        const bodyResult = validateBody(content);

        // Combine results
        const combined: ValidationResult = {
          isValid: fmResult.isValid && bodyResult.isValid,
          errors: [...fmResult.errors, ...bodyResult.errors],
          warnings: [...fmResult.warnings, ...bodyResult.warnings],
          score: Math.round((fmResult.score + bodyResult.score) / 2),
        };

        // Generate suggested fixes if there are issues
        let output = formatValidationResult(combined);
        if (!combined.isValid || combined.warnings.length > 0) {
          const fixes = generateFixes(content, frontmatter || {}, combined);
          if (fixes.length > 0) {
            output += formatSuggestedFixes(fixes);
          }
        }

        return {
          content: [{ type: 'text', text: output }],
        };
      }

      case 'docs_validate_frontmatter': {
        const result = validateFrontmatter(args?.frontmatter as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: formatValidationResult(result) }],
        };
      }

      // === STALENESS ===
      case 'docs_check_staleness': {
        const filePath = args?.filePath as string;
        const fullPath = path.join(getEffectiveDocsRoot(), filePath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const fm = parseFrontmatter(content);

        const result = await calculateStaleness(
          getEffectiveDocsRoot(),
          fm?.['last-verified'] as string | null,
          (fm?.sources as string[]) || [],
          getEffectiveProjectRoot()
        );

        return {
          content: [{ type: 'text', text: formatStalenessResult(filePath, result) }],
        };
      }

      case 'docs_scan_all_staleness': {
        const results = await scanAllDocs(getEffectiveDocsRoot(), getEffectiveProjectRoot(), parseDocFile);
        const report = generateStalenessReport(results);
        return {
          content: [{ type: 'text', text: report }],
        };
      }

      // === TEMPLATES ===
      case 'docs_generate_template': {
        const config: TemplateConfig = {
          title: args?.title as string,
          docId: suggestDocId(args?.title as string, args?.type as DocType),
          sources: args?.sources as string[],
          type: args?.type as DocType,
          aliases: args?.aliases as string[] | undefined,
          relatedDocs: args?.relatedDocs as string[] | undefined,
          component: args?.component as string | undefined,
          modules: args?.modules as string[] | undefined,
        };
        const template = generateDocument(config);
        return {
          content: [{ type: 'text', text: template }],
        };
      }

      case 'docs_generate_frontmatter': {
        const config: TemplateConfig = {
          title: args?.title as string,
          docId: suggestDocId(args?.title as string, args?.type as DocType),
          sources: args?.sources as string[],
          type: args?.type as DocType,
        };
        const fm = generateFrontmatter(config);
        return {
          content: [{ type: 'text', text: fm }],
        };
      }

      case 'docs_generate_diagram': {
        const type = args?.type as string;
        const data = args?.data as Record<string, unknown>;

        let diagram: string;
        switch (type) {
          case 'dataflow':
            diagram = generateDataFlowDiagram(
              data.steps as Array<{ id: string; label: string; next?: string }>
            );
            break;
          case 'architecture':
            diagram = generateArchitectureDiagram(
              data.components as Array<{ id: string; label: string; children?: string[] }>
            );
            break;
          case 'state':
            diagram = generateStateDiagram(
              data.states as Array<{ from: string; to: string; event: string }>
            );
            break;
          case 'sequence':
            diagram = generateSequenceDiagram(
              data.participants as string[],
              data.messages as Array<{ from: string; to: string; message: string }>
            );
            break;
          default:
            throw new Error(`Unknown diagram type: ${type}`);
        }

        return {
          content: [{ type: 'text', text: diagram }],
        };
      }

      case 'docs_suggest_filename': {
        const filename = generateFilename(args?.title as string);
        return {
          content: [{ type: 'text', text: filename }],
        };
      }

      case 'docs_suggest_sections': {
        const docType = args?.type as DocType;
        const recommendations = getSectionRecommendations(docType);

        let output = `## Section Ideas for ${docType} Documentation\n\n`;
        output += `> **Note**: These are typical sections for this doc type. Use your judgment:\n`;
        output += `> - Skip sections that don't apply to your specific content\n`;
        output += `> - Add custom sections if needed\n`;
        output += `> - Consider the doc's scope when deciding what to include\n\n`;

        const common = recommendations.filter(r => r.importance === 'common');
        const optional = recommendations.filter(r => r.importance === 'optional');

        if (common.length > 0) {
          output += `### Commonly Included\n\n`;
          for (const rec of common) {
            output += `#### ${rec.name}\n`;
            output += `${rec.description}\n\n`;
          }
        }

        if (optional.length > 0) {
          output += `### Often Useful (Situational)\n\n`;
          for (const rec of optional) {
            output += `#### ${rec.name}\n`;
            output += `${rec.description}\n\n`;
          }
        }

        output += `\n---\n\n`;
        output += `**Tip:** Use the \`docs://templates/exemplary\` resource to see a fully filled-in example of good documentation.\n`;

        return {
          content: [{ type: 'text', text: output }],
        };
      }

      // === INDEX ===
      case 'docs_index_add': {
        const today = new Date().toISOString().split('T')[0];
        const edits = generateIndexAdditions(
          args?.docPath as string,
          args?.docTitle as string,
          args?.sources as string[],
          args?.category as string,
          today
        );
        const description = describeIndexEdits(edits);
        return {
          content: [{ type: 'text', text: description }],
        };
      }

      case 'docs_index_move': {
        const edits = generateMoveEdits(
          args?.oldPath as string,
          args?.newPath as string,
          args?.docTitle as string
        );
        const description = describeIndexEdits(edits);
        return {
          content: [{ type: 'text', text: description }],
        };
      }

      case 'docs_index_apply': {
        const indexPath = path.join(getEffectiveDocsRoot(), 'index.md');
        const operation = args?.operation as 'add' | 'move' | 'archive';

        const result = applyAndSaveIndex(indexPath, operation, {
          docPath: args?.docPath as string,
          docTitle: args?.docTitle as string | undefined,
          sources: args?.sources as string[] | undefined,
          category: args?.category as string | undefined,
          oldPath: args?.oldPath as string | undefined,
          newPath: args?.newPath as string | undefined,
          archivePath: args?.archivePath as string | undefined,
          archiveReason: args?.archiveReason as string | undefined,
        });

        let output = `## Index Update Result\n\n`;
        output += `**Operation:** ${operation}\n`;
        output += `**Success:** ${result.success ? '✅ Yes' : '❌ No'}\n\n`;

        if (result.changes.length > 0) {
          output += `### Changes Made\n\n`;
          for (const change of result.changes) {
            output += `- ${change}\n`;
          }
          output += '\n';
        }

        if (result.errors.length > 0) {
          output += `### Errors\n\n`;
          for (const error of result.errors) {
            output += `- ⚠️ ${error}\n`;
          }
          output += '\n';
        }

        return {
          content: [{ type: 'text', text: output }],
        };
      }

      case 'docs_index_reconcile': {
        const docsRoot = getEffectiveDocsRoot();
        const indexPath = path.join(docsRoot, 'index.md');

        const result = reconcileIndex(indexPath, docsRoot);
        const report = formatReconciliationReport(result);

        return {
          content: [{ type: 'text', text: report }],
        };
      }

      // === BACKUP ===
      case 'docs_backup_file': {
        const result = backupFileBeforeEdit(
          getEffectiveDocsRoot(),
          path.join(getEffectiveDocsRoot(), args?.filePath as string),
          args?.reason as string
        );
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `✅ Backup created: ${result.backupEntry?.backupPath}`
                : `❌ Backup failed: ${result.error}`,
            },
          ],
        };
      }

      case 'docs_backup_snapshot': {
        const result = createSnapshot(getEffectiveDocsRoot(), args?.reason as string);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `✅ Snapshot created: ${result.backupEntry?.backupPath} (${result.backupEntry?.fileCount} files)`
                : `❌ Snapshot failed: ${result.error}`,
            },
          ],
        };
      }

      case 'docs_backup_list': {
        const backups = listBackups(getEffectiveDocsRoot(), {
          type: args?.type as 'snapshot' | 'pre-edit' | 'pre-archive' | undefined,
          sourceFile: args?.sourceFile as string | undefined,
        });

        if (backups.length === 0) {
          return { content: [{ type: 'text', text: 'No backups found.' }] };
        }

        let output = '## Backups\n\n';
        output += '| Type | Source | Backup Path | Date | Reason |\n';
        output += '|------|--------|-------------|------|--------|\n';
        for (const b of backups) {
          const date = new Date(b.timestamp).toISOString().split('T')[0];
          output += `| ${b.type} | ${b.sourcePath} | ${b.backupPath} | ${date} | ${b.reason} |\n`;
        }
        return { content: [{ type: 'text', text: output }] };
      }

      case 'docs_backup_restore': {
        const result = restoreFromBackup(
          getEffectiveDocsRoot(),
          args?.backupPath as string,
          args?.targetPath as string | undefined
        );
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `✅ Restored to: ${result.restoredPath}`
                : `❌ Restore failed: ${result.error}`,
            },
          ],
        };
      }

      case 'docs_backup_cleanup': {
        const result = cleanupOldBackups(getEffectiveDocsRoot(), {
          retentionDays: args?.retentionDays as number | undefined,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Cleanup complete: ${result.removed} backups removed${result.errors.length > 0 ? `, ${result.errors.length} errors` : ''}`,
            },
          ],
        };
      }

      // === SOURCE VERIFICATION ===
      case 'docs_extract_source_facts': {
        const sourcePaths = args?.sourcePaths as string[];
        const filterTypes = args?.filterTypes as string[] | undefined;
        const allFacts: SourceFact[] = [];
        const projectRoot = getEffectiveProjectRoot();

        for (const sourcePath of sourcePaths) {
          const fullPath = path.join(projectRoot, sourcePath);
          if (!fs.existsSync(fullPath)) continue;

          // Use pluggable extractor registry
          const facts = extractFacts(fullPath, projectRoot, filterTypes);
          allFacts.push(...facts);
        }

        if (allFacts.length === 0) {
          const supportedExts = getSupportedExtensions().join(', ');
          return {
            content: [{ type: 'text', text: `No facts extracted. Ensure source paths point to supported file types: ${supportedExts}` }],
          };
        }

        let output = `## Extracted ${allFacts.length} Facts\n\n`;
        output += '| Type | Name | Details | Location |\n';
        output += '|------|------|---------|----------|\n';
        for (const fact of allFacts) {
          output += `| ${fact.factType} | \`${fact.name}\` | \`${fact.details}\` | ${fact.file}:${fact.line} |\n`;
        }

        output += '\n**Use these facts to verify documentation accuracy.**';

        return {
          content: [{ type: 'text', text: output }],
        };
      }

      case 'docs_verify_against_source': {
        const docPath = args?.docPath as string;
        const sourcePaths = args?.sourcePaths as string[];
        const filterTypes = args?.filterTypes as string[] | undefined;
        const fullDocPath = path.join(getEffectiveDocsRoot(), docPath);

        const report = generateVerificationReport(fullDocPath, sourcePaths, getEffectiveProjectRoot(), filterTypes);

        let output = `## Source Verification Report\n\n`;
        output += `**Document**: ${docPath}\n`;
        output += `**Score**: ${report.score}/100 ${report.passesVerification ? '✅ PASS' : '❌ FAIL'}\n\n`;

        if (report.missingFacts.length > 0) {
          output += `### Missing Facts (${report.missingFacts.length})\n\n`;
          output += 'These facts from source code are NOT found in the documentation:\n\n';
          for (const fact of report.missingFacts) {
            output += `- **${fact.name}** (${fact.factType}): \`${fact.details}\` — ${fact.file}:${fact.line}\n`;
          }
        } else {
          output += '### All Key Facts Present ✅\n\n';
        }

        const suggestions = generateEditSuggestions(report);
        output += '\n---\n\n';
        output += suggestions.join('\n');

        return {
          content: [{ type: 'text', text: output }],
        };
      }

      case 'docs_prepare_update': {
        const docPath = args?.docPath as string;
        const sourcePaths = args?.sourcePaths as string[];
        const filterTypes = args?.filterTypes as string[] | undefined;
        const reason = args?.reason as string;
        const docsRoot = getEffectiveDocsRoot();
        const projectRoot = getEffectiveProjectRoot();
        const fullDocPath = path.join(docsRoot, docPath);

        let output = `## Preparing Update for ${docPath}\n\n`;

        // Step 1: Create backup
        if (fs.existsSync(fullDocPath)) {
          const backupResult = backupFileBeforeEdit(docsRoot, fullDocPath, reason);
          if (backupResult.success) {
            output += `### Step 1: Backup Created ✅\n`;
            output += `Backup: \`${backupResult.backupEntry?.backupPath}\`\n\n`;
          } else {
            output += `### Step 1: Backup Failed ❌\n`;
            output += `Error: ${backupResult.error}\n\n`;
            output += '**STOP: Do not proceed without a backup.**\n';
            return { content: [{ type: 'text', text: output }] };
          }
        } else {
          output += `### Step 1: No Backup Needed\n`;
          output += `Document does not exist yet (new document).\n\n`;
        }

        // Step 2: Determine doc type and verification strategy
        // Priority: 1) Folder location (most authoritative), 2) Content analysis, 3) Frontmatter tags (fallback)
        let docType: DocType = 'backend'; // default
        let docTypeSource = 'default';

        // First: Infer from folder path (this is the primary signal)
        const pathInferredType = inferDocTypeFromPath(docPath);
        if (pathInferredType) {
          docType = pathInferredType as DocType;
          docTypeSource = 'folder location';
        } else if (fs.existsSync(fullDocPath)) {
          // If not in a recognizable folder, check content and tags
          const content = fs.readFileSync(fullDocPath, 'utf-8');
          const fm = parseFrontmatter(content);

          // Check if it looks like a guide (regardless of folder)
          if (fm && isGuideDocument(fm.title as string || '', content)) {
            docType = 'guide';
            docTypeSource = 'content analysis (guide-like structure)';
          } else if (fm) {
            // Fallback: Use frontmatter tags
            const tagInferredType = inferDocTypeFromTags(fm.tags as string[] | undefined);
            if (tagInferredType) {
              docType = tagInferredType as DocType;
              docTypeSource = 'frontmatter tags';
            }
          }
        }

        const strategy = getVerificationStrategy(docType);
        output += `### Step 2: Doc Type Analysis\n`;
        output += `**Type**: ${docType} (inferred from ${docTypeSource})\n`;
        output += `**Verification Strategy**: ${strategy}\n\n`;
        output += getStrategyExplanation(docType) + '\n\n';

        // Step 3: Run appropriate verification based on strategy
        if (strategy === 'source-facts' || strategy === 'hybrid') {
          // Run source fact verification
          const report = generateVerificationReport(fullDocPath, sourcePaths, projectRoot, filterTypes);
          output += `### Step 3a: Source Fact Verification\n`;
          output += `Found ${report.facts.length} key facts from source files.\n`;
          output += `**Score**: ${report.score}/100 ${report.passesVerification ? '✅' : '❌'}\n\n`;

          if (report.missingFacts.length > 0) {
            output += `#### Missing Source Facts (${report.missingFacts.length})\n\n`;
            for (const fact of report.missingFacts.slice(0, 5)) {
              output += `- **${fact.name}**: \`${fact.details}\` (${fact.file}:${fact.line})\n`;
            }
            if (report.missingFacts.length > 5) {
              output += `- ... and ${report.missingFacts.length - 5} more\n`;
            }
            output += '\n';
          } else {
            output += `All key source facts are documented. ✅\n\n`;
          }
        }

        if (strategy === 'conceptual' || strategy === 'hybrid') {
          // Run conceptual completeness checks
          const conceptualReport = runConceptualChecks(fullDocPath, docType);
          output += `### Step 3b: Conceptual Completeness Check\n`;
          output += `**Score**: ${conceptualReport.score}/100 ${conceptualReport.passesConceptualReview ? '✅' : '❌'}\n\n`;

          const passed = conceptualReport.checks.filter(r => r.found);
          const failed = conceptualReport.checks.filter(r => !r.found);

          if (passed.length > 0) {
            output += `**Present**: ${passed.map(r => r.check.name).join(', ')}\n`;
          }
          if (failed.length > 0) {
            output += `\n**Missing**:\n`;
            for (const result of failed) {
              const marker = result.check.required ? '❌ (required)' : '⚠️ (optional)';
              output += `- **${result.check.name}** ${marker}\n`;
              output += `  ${result.check.description}\n`;
            }
          }
          output += '\n';
        }

        // Step 4: Doc-type specific guidance
        output += `---\n\n`;
        output += `### How to Proceed\n\n`;
        output += getDocTypeGuidance(docType) + '\n\n';

        if (!fs.existsSync(fullDocPath)) {
          output += '**New Document Steps:**\n';
          output += '1. Use `docs_generate_template` to create initial structure.\n';
          output += '2. Fill in all sections appropriate for this doc type.\n';
          output += '3. Focus on conceptual content for architecture/guide docs.\n';
        } else {
          output += '**Update Steps:**\n';
          output += '1. **DO NOT** rewrite the entire document.\n';
          output += '2. Use **Edit tool** for targeted changes.\n';
          output += '3. Preserve all existing correct content verbatim.\n';
          output += '4. Update `last-verified` date and add History entry.\n';
        }

        return {
          content: [{ type: 'text', text: output }],
        };
      }

      // === ARCHIVE ===
      case 'docs_archive': {
        const result = archiveDocument(getEffectiveDocsRoot(), {
          docPath: args?.docPath as string,
          reason: args?.reason as ArchiveReason,
          supersededBy: args?.supersededBy as string | undefined,
          notes: args?.notes as string | undefined,
        });

        if (!result.success) {
          return { content: [{ type: 'text', text: `❌ Archive failed: ${result.error}` }] };
        }

        let output = `## Document Archived\n\n`;
        output += `**Archived to:** ${result.archivedPath}\n\n`;
        output += `### Index Updates Required\n\n`;
        output += `**Add to Redirect Map:**\n\`\`\`\n${result.redirectEntry}\n\`\`\`\n\n`;
        output += `**Add to Archive section:**\n\`\`\`\n${result.archiveEntry}\n\`\`\`\n\n`;
        output += `**Other updates:**\n`;
        for (const edit of result.indexEdits || []) {
          output += `- ${edit}\n`;
        }

        return { content: [{ type: 'text', text: output }] };
      }

      case 'docs_archive_restore': {
        const result = restoreFromArchive(
          getEffectiveDocsRoot(),
          args?.archivePath as string,
          args?.targetPath as string | undefined
        );

        if (!result.success) {
          return { content: [{ type: 'text', text: `❌ Restore failed: ${result.error}` }] };
        }

        let output = `## Document Restored\n\n`;
        output += `**Restored to:** ${result.archivedPath}\n\n`;
        output += `### Index Updates Required\n\n`;
        for (const edit of result.indexEdits || []) {
          output += `- ${edit}\n`;
        }

        return { content: [{ type: 'text', text: output }] };
      }

      case 'docs_archive_list': {
        const archived = listArchived(getEffectiveDocsRoot());

        if (archived.length === 0) {
          return { content: [{ type: 'text', text: 'No archived documents.' }] };
        }

        let output = '## Archived Documents\n\n';
        output += '| Path | Original | Archived Date | Reason |\n';
        output += '|------|----------|---------------|--------|\n';
        for (const doc of archived) {
          output += `| ${doc.path} | ${doc.metadata?.originalPath || 'unknown'} | ${doc.metadata?.archivedDate || 'unknown'} | ${doc.metadata?.reason || 'unknown'} |\n`;
        }
        return { content: [{ type: 'text', text: output }] };
      }

      case 'docs_archive_suggest': {
        const candidates = suggestArchiveCandidates(getEffectiveDocsRoot(), (content) =>
          parseFrontmatter(content)
        );

        if (candidates.length === 0) {
          return {
            content: [{ type: 'text', text: 'No documents matched archival candidate patterns.' }],
          };
        }

        let output = '## Potential Archive Candidates\n\n';
        output += '> **Note**: These are pattern matches, not archival decisions.\n';
        output += '> Review each candidate and verify before archiving.\n\n';
        output += '| Path | Signal | Possible Type | Verify Before Archiving |\n';
        output += '|------|--------|---------------|-------------------------|\n';
        for (const c of candidates) {
          output += `| ${c.path} | ${c.signal} | ${c.possibleArchiveType} | ${c.verifyBefore} |\n`;
        }
        return { content: [{ type: 'text', text: output }] };
      }

      // === UTILITIES ===
      case 'docs_generate_history_entry': {
        const today = new Date().toISOString().split('T')[0];
        const entry = generateHistoryEntry(
          today,
          args?.title as string,
          args?.changes as string[]
        );
        return { content: [{ type: 'text', text: entry }] };
      }

      case 'docs_generate_verification_notes': {
        const today = new Date().toISOString().split('T')[0];
        const notes = generateVerificationNotes(
          today,
          args?.method as string,
          args?.verifiedItems as string[],
          args?.driftChecks as string[]
        );
        return { content: [{ type: 'text', text: notes }] };
      }

      // === REORGANIZATION TOOLS ===
      case 'docs_analyze_placement': {
        const docsRoot = getEffectiveDocsRoot();
        const results = analyzePlacement(docsRoot, (filePath) => {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const frontmatter = parseFrontmatter(content);
            return { frontmatter, content };
          } catch {
            return null;
          }
        });

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: '## Placement Analysis\n\nNo potential misplacements detected. All docs appear to be in appropriate folders.' }],
          };
        }

        let output = '## Placement Analysis\n\n';
        output += '> **Note**: These are content-based signals, not definitive assessments.\n';
        output += '> Verify each suggestion before moving files.\n\n';
        output += '| Doc | Current Folder | Content Suggests | Signals | Verify Before Moving |\n';
        output += '|-----|----------------|------------------|---------|---------------------|\n';
        for (const r of results) {
          output += `| ${r.docPath} | ${r.currentFolder} | ${r.suggestedFolder || '-'} | ${r.contentSignals.join(', ') || '-'} | ${r.verifyBefore} |\n`;
        }
        output += '\n';
        output += `**Summary**: ${results.length} doc(s) may be in the wrong folder based on content analysis.\n`;

        return { content: [{ type: 'text', text: output }] };
      }

      case 'docs_find_overlaps': {
        const docsRoot = getEffectiveDocsRoot();
        const results = findOverlaps(docsRoot, (filePath) => {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const frontmatter = parseFrontmatter(content);
            return { frontmatter, content };
          } catch {
            return null;
          }
        });

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: '## Overlap Analysis\n\nNo overlapping documentation detected.' }],
          };
        }

        let output = '## Overlap Analysis\n\n';
        output += '> **Note**: Overlapping docs are candidates for consolidation.\n';
        output += '> Fewer well-maintained docs are better than many partial ones.\n\n';

        for (let i = 0; i < results.length; i++) {
          const overlap = results[i];
          output += `### Overlap Group ${i + 1}: ${overlap.overlapType}\n\n`;
          output += `**Signal**: ${overlap.signal}\n\n`;
          output += '**Documents**:\n';
          for (const doc of overlap.docs) {
            output += `- \`${doc.path}\` - "${doc.title}"\n`;
            if (doc.sources.length > 0) {
              output += `  Sources: ${doc.sources.slice(0, 3).join(', ')}${doc.sources.length > 3 ? '...' : ''}\n`;
            }
          }
          if (overlap.sharedSources.length > 0) {
            output += `\n**Shared Sources**: ${overlap.sharedSources.join(', ')}\n`;
          }
          output += '\n**Questions to Consider**:\n';
          for (const q of overlap.consolidationQuestions) {
            output += `- ${q}\n`;
          }
          output += '\n---\n\n';
        }

        output += `**Summary**: ${results.length} potential overlap(s) found. Review each for consolidation opportunities.\n`;

        return { content: [{ type: 'text', text: output }] };
      }

      case 'docs_analyze_health': {
        const docsRoot = getEffectiveDocsRoot();
        const indexPath = path.join(docsRoot, 'index.md');
        const indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '';

        const results = analyzeHealth(docsRoot, indexContent, (filePath) => {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const frontmatter = parseFrontmatter(content);
            return { frontmatter, content };
          } catch {
            return null;
          }
        });

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: '## Health Analysis\n\nAll docs appear healthy. No concerns detected.' }],
          };
        }

        let output = '## Documentation Health Analysis\n\n';
        output += '> **Note**: Health signals encourage "gardening" - maintaining fewer, better docs.\n';
        output += '> Consider archiving or merging docs with multiple concerns.\n\n';

        // Group by health score
        const removalCandidates = results.filter(r => r.healthScore === 'candidate-for-removal');
        const needsAttention = results.filter(r => r.healthScore === 'needs-attention');

        if (removalCandidates.length > 0) {
          output += '### Candidates for Removal/Merge\n\n';
          output += 'These docs have multiple health concerns:\n\n';
          for (const doc of removalCandidates) {
            output += `**${doc.docPath}** - "${doc.title}"\n`;
            for (const sig of doc.signals) {
              const icon = sig.severity === 'concern' ? '❌' : sig.severity === 'warning' ? '⚠️' : 'ℹ️';
              output += `- ${icon} ${sig.description}\n`;
            }
            output += `- Possible actions: ${doc.possibleActions.join('; ')}\n\n`;
          }
        }

        if (needsAttention.length > 0) {
          output += '### Needs Attention\n\n';
          output += '| Doc | Issues | Suggested Action |\n';
          output += '|-----|--------|------------------|\n';
          for (const doc of needsAttention) {
            const issues = doc.signals.map(s => s.type).join(', ');
            const action = doc.possibleActions[0] || '-';
            output += `| ${doc.docPath} | ${issues} | ${action} |\n`;
          }
          output += '\n';
        }

        output += `**Summary**: ${removalCandidates.length} removal candidate(s), ${needsAttention.length} needing attention.\n`;

        return { content: [{ type: 'text', text: output }] };
      }

      case 'docs_reorganization_report': {
        const docsRoot = getEffectiveDocsRoot();
        const indexPath = path.join(docsRoot, 'index.md');

        const report = generateReorganizationReport(docsRoot, indexPath, (filePath) => {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const frontmatter = parseFrontmatter(content);
            return { frontmatter, content };
          } catch {
            return null;
          }
        });

        let output = '## Documentation Reorganization Report\n\n';
        output += '> This report encourages documentation "gardening".\n';
        output += '> Fewer, well-maintained docs are better than many neglected ones.\n\n';

        output += '### Summary\n\n';
        output += `- **Total Docs**: ${report.totalDocs}\n`;
        output += `- **Healthy Docs**: ${report.summary.healthyDocs}\n`;
        output += `- **Possible Misplacements**: ${report.summary.possibleMisplacements}\n`;
        output += `- **Possible Overlaps**: ${report.summary.possibleOverlaps}\n`;
        output += `- **Removal Candidates**: ${report.summary.removalCandidates}\n\n`;

        output += '### Gardening Notes\n\n';
        for (const note of report.gardeningNotes) {
          output += `- ${note}\n`;
        }
        output += '\n';

        if (report.misplacedDocs.length > 0) {
          output += '### Placement Issues\n\n';
          output += 'Use `docs_analyze_placement` for details.\n\n';
          for (const doc of report.misplacedDocs.slice(0, 5)) {
            output += `- \`${doc.docPath}\`: ${doc.currentFolder} → ${doc.suggestedFolder}\n`;
          }
          if (report.misplacedDocs.length > 5) {
            output += `- ... and ${report.misplacedDocs.length - 5} more\n`;
          }
          output += '\n';
        }

        if (report.overlappingDocs.length > 0) {
          output += '### Overlap Concerns\n\n';
          output += 'Use `docs_find_overlaps` for details.\n\n';
          for (const overlap of report.overlappingDocs.slice(0, 3)) {
            output += `- ${overlap.signal}\n`;
          }
          if (report.overlappingDocs.length > 3) {
            output += `- ... and ${report.overlappingDocs.length - 3} more\n`;
          }
          output += '\n';
        }

        if (report.healthConcerns.length > 0) {
          output += '### Health Concerns\n\n';
          output += 'Use `docs_analyze_health` for details.\n\n';
          const worstCases = report.healthConcerns.filter(h => h.healthScore === 'candidate-for-removal');
          for (const doc of worstCases.slice(0, 5)) {
            output += `- \`${doc.docPath}\`: ${doc.signals.map(s => s.type).join(', ')}\n`;
          }
          if (worstCases.length > 5) {
            output += `- ... and ${worstCases.length - 5} more\n`;
          }
        }

        return { content: [{ type: 'text', text: output }] };
      }

      case 'docs_move_file': {
        const docsRoot = getEffectiveDocsRoot();
        const oldPath = args?.oldPath as string;
        const newPath = args?.newPath as string;
        const updateIndexFlag = args?.updateIndex !== false; // default true

        const result = moveDocFile(docsRoot, oldPath, newPath, (old, newP) => {
          if (updateIndexFlag) {
            const indexPath = path.join(docsRoot, 'index.md');
            applyAndSaveIndex(indexPath, 'move', { oldPath: old, newPath: newP, docPath: newP });
          }
        });

        if (!result.success) {
          return { content: [{ type: 'text', text: `❌ Move failed: ${result.error}` }] };
        }

        let output = '## File Moved Successfully\n\n';
        output += `**From**: \`${oldPath}\`\n`;
        output += `**To**: \`${newPath}\`\n`;
        output += `**Backup**: \`${result.backupPath}\`\n\n`;

        if (result.crossRefsToUpdate.length > 0) {
          output += '### Cross-References to Update\n\n';
          output += 'The following files reference the old path:\n\n';
          for (const ref of result.crossRefsToUpdate) {
            output += `- \`${ref.file}\`:${ref.line} - \`${ref.content.substring(0, 80)}...\`\n`;
          }
          output += '\n**Action**: Update these references to point to the new path.\n';
        } else {
          output += 'No cross-references found to update.\n';
        }

        return { content: [{ type: 'text', text: output }] };
      }

      case 'docs_delete_file': {
        const docsRoot = getEffectiveDocsRoot();
        const docPath = args?.docPath as string;
        const reason = args?.reason as string;

        const result = deleteDocFile(docsRoot, docPath, reason, (dp, r, notes) => {
          return archiveDocument(docsRoot, {
            docPath: dp,
            reason: r as ArchiveReason,
            notes,
          });
        });

        if (!result.success) {
          return { content: [{ type: 'text', text: `❌ Delete failed: ${result.error}` }] };
        }

        let output = '## Document Deleted (Archived)\n\n';
        output += `**Archived to**: \`${result.archivedTo}\`\n`;
        output += `**Reason**: ${reason}\n\n`;
        output += '> The document is not permanently deleted - it\'s archived for recovery if needed.\n';

        return { content: [{ type: 'text', text: output }] };
      }

      case 'docs_merge_files': {
        const docsRoot = getEffectiveDocsRoot();
        const sourcePaths = args?.sourcePaths as string[];
        const targetPath = args?.targetPath as string;
        const mergedContent = args?.mergedContent as string;

        if (!mergedContent) {
          return {
            content: [{ type: 'text', text: '❌ Merge failed: mergedContent is required. Provide the combined document content.' }],
          };
        }

        const result = mergeDocFiles(docsRoot, sourcePaths, targetPath, mergedContent, (dp, r, notes) => {
          return archiveDocument(docsRoot, {
            docPath: dp,
            reason: r as ArchiveReason,
            notes,
          });
        });

        if (!result.success) {
          return { content: [{ type: 'text', text: `❌ Merge failed: ${result.error}` }] };
        }

        let output = '## Documents Merged Successfully\n\n';
        output += `**Target**: \`${targetPath}\`\n`;
        output += `**Source docs archived**: ${result.archivedDocs.length}\n\n`;

        if (result.archivedDocs.length > 0) {
          output += '### Archived (Former Sources)\n\n';
          for (const doc of result.archivedDocs) {
            output += `- \`${doc}\` → archive/\n`;
          }
          output += '\n';
        }

        if (result.crossRefsToUpdate.length > 0) {
          output += '### Cross-References to Update\n\n';
          output += 'These files reference the archived docs:\n\n';
          for (const ref of result.crossRefsToUpdate) {
            output += `- \`${ref.file}\` references: ${ref.references.join(', ')}\n`;
          }
          output += '\n**Action**: Update these references to point to the merged doc.\n';
        }

        return { content: [{ type: 'text', text: output }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error}` }],
      isError: true,
    };
  }
});

// ============================================================================
// Server Startup
// ============================================================================

async function main() {
  // Get configuration from environment or arguments
  // These override the auto-detected config if provided
  DOCS_ROOT = process.env.DOCS_ROOT || process.argv[2] || '';
  PROJECT_ROOT = process.env.PROJECT_ROOT || process.argv[3] || '';

  // Resolve to absolute paths if provided
  if (DOCS_ROOT) {
    DOCS_ROOT = path.resolve(DOCS_ROOT);
  }
  if (PROJECT_ROOT) {
    PROJECT_ROOT = path.resolve(PROJECT_ROOT);
  }

  // Load config (auto-detects project type)
  const config = loadConfig(PROJECT_ROOT || undefined);

  console.error(`Documentation Manager MCP Server v1.0.0`);
  console.error(`  Project root: ${getEffectiveProjectRoot()}`);
  console.error(`  Docs root: ${getEffectiveDocsRoot()}`);
  console.error(`  Preset: ${config.preset || 'auto'}${config.detectionReasons?.length ? ` (${config.detectionReasons.join(', ')})` : ''}`);
  console.error(`  Languages: ${config.languages.length > 0 ? config.languages.join(', ') : '(none)'}`);
  console.error(`  Doc types: ${Object.keys(config.docTypes).join(', ')}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
