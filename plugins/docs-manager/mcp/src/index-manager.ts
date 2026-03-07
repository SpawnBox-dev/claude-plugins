/**
 * Index Manager
 *
 * Manages the docs/index.md file with proper table formats for:
 * - Redirect Map (old path → new path)
 * - Source to Documentation Map
 * - Staleness Dashboard
 * - Documentation by Category
 * - Archive section
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface SourceMapEntry {
  sourceFile: string;
  docName: string;
  docPath: string;
  lastVerified: string;
  trust: '✅' | '⚠️' | '❌' | '🕐';
  isCanonical?: boolean;
}

export interface CategoryEntry {
  docFilename: string;
  docPath: string;
  status: 'current' | 'draft' | 'deprecated';
  lastVerified: string;
  trust: string;
}

export interface RedirectEntry {
  oldPath: string;
  newPath: string;
  movedDate: string;
}

export interface ArchiveEntry {
  archivedName: string;
  archivePath: string;
  originalName: string;
  archiveDate: string;
  archiveType: string;
}

export interface StaleEntry {
  docPath: string;
  lastVerified: string;
  issueSummary: string;
  severity: 'CRITICAL' | 'WARNING';
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface IndexUpdateResult {
  success: boolean;
  edits: IndexEdit[];
  errors: string[];
}

export interface IndexEdit {
  section: string;
  action: 'add' | 'update' | 'remove';
  content: string;
}

// ============================================================================
// Index Section Patterns
// ============================================================================

const SECTION_PATTERNS = {
  redirectMap: /## Redirect Map \(Link Stability\)[\s\S]*?(?=\n---|\n## )/,
  sourceToDocMap: /## Source to Documentation Map[\s\S]*?(?=\n---|\n## )/,
  backendCore: /### Backend Core[\s\S]*?(?=\n### |\n---|\n## )/,
  frontend: /### Frontend[\s\S]*?(?=\n### |\n---|\n## )/,
  database: /### Database[\s\S]*?(?=\n### |\n---|\n## )/,
  stalenessDashboard: /## Staleness Dashboard[\s\S]*?(?=\n---|\n## )/,
  currentlyStale: /### Currently Stale Documentation[\s\S]*?(?=\n### |\n---|\n## )/,
  recentlyVerified: /### Recently Verified[\s\S]*?(?=\n### |\n---|\n## )/,
  docsByCategory: /## Documentation by Category[\s\S]*?(?=\n---|\n## )/,
  metaSection: /### Meta[\s\S]*?(?=\n### |\n---|\n## )/,
  architectureSection: /### Architecture[\s\S]*?(?=\n### |\n---|\n## )/,
  backendSection: /### Backend \(`docs\/backend\/`\)[\s\S]*?(?=\n### |\n---|\n## )/,
  frontendSection: /### Frontend \(`docs\/frontend\/`\)[\s\S]*?(?=\n### |\n---|\n## )/,
  apiSection: /### API Integrations[\s\S]*?(?=\n### |\n---|\n## )/,
  databaseSection: /### Database[\s\S]*?(?=\n### |\n---|\n## )/,
  datapackSection: /### Datapack[\s\S]*?(?=\n### |\n---|\n## )/,
  guidesSection: /### Guides[\s\S]*?(?=\n### |\n---|\n## )/,
  archiveSection: /### Archive[\s\S]*?(?=\n### |\n---|\n## )/,
  uncoveredSources: /## Uncovered Source Files[\s\S]*?(?=\n---|\n## )/,
};

// ============================================================================
// Table Row Generators
// ============================================================================

/**
 * Generate a Source to Doc Map table row
 */
export function formatSourceMapRow(entry: SourceMapEntry): string {
  const canonical = entry.isCanonical ? ' ⭐' : '';
  return `| \`${entry.sourceFile}\` | [${entry.docName}](${entry.docPath})${canonical} | ${entry.lastVerified} | ${entry.trust} |`;
}

/**
 * Generate a Category table row
 */
export function formatCategoryRow(entry: CategoryEntry): string {
  return `| [${entry.docFilename}](${entry.docPath}) | ${entry.status} | ${entry.lastVerified} | ${entry.trust} |`;
}

/**
 * Generate a Redirect Map table row
 */
export function formatRedirectRow(entry: RedirectEntry): string {
  return `| \`${entry.oldPath}\` | \`${entry.newPath}\` | ${entry.movedDate} |`;
}

/**
 * Generate an Archive table row
 */
export function formatArchiveRow(entry: ArchiveEntry): string {
  return `| [${entry.archivedName}](${entry.archivePath}) | \`${entry.originalName}\` | ${entry.archiveDate} | ${entry.archiveType} |`;
}

/**
 * Generate a Stale doc table row
 */
export function formatStaleRow(entry: StaleEntry): string {
  return `| [${path.basename(entry.docPath)}](${entry.docPath}) | ${entry.lastVerified} | ${entry.issueSummary} | ${entry.severity} | ${entry.priority} |`;
}

// ============================================================================
// Index Operations
// ============================================================================

/**
 * Add a new doc to the appropriate sections of index.md
 */
export function generateIndexAdditions(
  docPath: string,
  docTitle: string,
  sources: string[],
  category: string,
  lastVerified: string
): IndexEdit[] {
  const edits: IndexEdit[] = [];
  const today = new Date().toISOString().split('T')[0];
  const docFilename = path.basename(docPath);

  // Add to Source to Doc Map for each source
  for (const source of sources) {
    edits.push({
      section: 'Source to Documentation Map',
      action: 'add',
      content: formatSourceMapRow({
        sourceFile: source,  // Use full path - let users configure path display if needed
        docName: docTitle,
        docPath: docPath,
        lastVerified,
        trust: '✅',
        isCanonical: true,
      }),
    });
  }

  // Add to Category section
  edits.push({
    section: `Documentation by Category - ${category}`,
    action: 'add',
    content: formatCategoryRow({
      docFilename,
      docPath,
      status: 'current',
      lastVerified,
      trust: '✅',
    }),
  });

  // Add to Recently Verified
  edits.push({
    section: 'Recently Verified',
    action: 'add',
    content: `| [${docFilename}](${docPath}) | ${today} | code-review | ✅ FRESH |`,
  });

  return edits;
}

/**
 * Generate edits for moving/renaming a doc
 */
export function generateMoveEdits(
  oldPath: string,
  newPath: string,
  docTitle: string
): IndexEdit[] {
  const edits: IndexEdit[] = [];
  const today = new Date().toISOString().split('T')[0];

  // Add to Redirect Map
  edits.push({
    section: 'Redirect Map',
    action: 'add',
    content: formatRedirectRow({
      oldPath: path.basename(oldPath),
      newPath,
      movedDate: today,
    }),
  });

  // Update all references (Category tables, Source Map, etc.)
  edits.push({
    section: 'All sections',
    action: 'update',
    content: `Replace all occurrences of "${oldPath}" with "${newPath}"`,
  });

  return edits;
}

/**
 * Generate edits for archiving a doc
 */
export function generateArchiveEdits(
  docPath: string,
  archivePath: string,
  archiveReason: string
): IndexEdit[] {
  const edits: IndexEdit[] = [];
  const today = new Date().toISOString().split('T')[0];
  const originalName = path.basename(docPath);
  const archivedName = path.basename(archivePath);

  // Remove from category section
  edits.push({
    section: 'Documentation by Category',
    action: 'remove',
    content: `Remove row containing ${docPath}`,
  });

  // Add to Archive section
  edits.push({
    section: 'Archive',
    action: 'add',
    content: formatArchiveRow({
      archivedName: archivedName.replace('.md', ''),
      archivePath,
      originalName,
      archiveDate: today,
      archiveType: archiveReason,
    }),
  });

  // Add to Redirect Map
  edits.push({
    section: 'Redirect Map',
    action: 'add',
    content: formatRedirectRow({
      oldPath: originalName,
      newPath: archivePath,
      movedDate: today,
    }),
  });

  // Update Source to Doc Map
  edits.push({
    section: 'Source to Documentation Map',
    action: 'update',
    content: `Remove or redirect entries pointing to ${docPath}`,
  });

  return edits;
}

/**
 * Generate edits for updating staleness dashboard
 */
export function generateStalenessUpdates(
  staleEntries: StaleEntry[],
  freshEntries: Array<{ docPath: string; method: string }>
): IndexEdit[] {
  const edits: IndexEdit[] = [];
  const today = new Date().toISOString().split('T')[0];

  // Update Currently Stale section
  if (staleEntries.length > 0) {
    let staleTable = `| Doc | Last Verified | Issue Summary | Severity | Priority |\n`;
    staleTable += `|-----|---------------|---------------|----------|----------|\n`;
    for (const entry of staleEntries) {
      staleTable += formatStaleRow(entry) + '\n';
    }

    edits.push({
      section: 'Currently Stale Documentation',
      action: 'update',
      content: staleTable,
    });
  }

  // Update Recently Verified section
  if (freshEntries.length > 0) {
    let recentTable = `| Doc | Verified | Method | Assessment |\n`;
    recentTable += `|-----|----------|--------|------------|\n`;
    for (const entry of freshEntries) {
      const docFilename = path.basename(entry.docPath);
      recentTable += `| [${docFilename}](${entry.docPath}) | ${today} | ${entry.method} | ✅ FRESH |\n`;
    }

    edits.push({
      section: 'Recently Verified',
      action: 'update',
      content: recentTable,
    });
  }

  return edits;
}

// ============================================================================
// Index File Operations
// ============================================================================

/**
 * Read and parse the index file
 */
export function readIndex(indexPath: string): string {
  return fs.readFileSync(indexPath, 'utf-8');
}

/**
 * Find a table in a section and add a row
 */
export function addRowToTable(
  content: string,
  sectionPattern: RegExp,
  newRow: string
): string {
  const match = content.match(sectionPattern);
  if (!match) {
    return content; // Section not found
  }

  const section = match[0];

  // Find the last row of the table (before the next section or end)
  const tableEndMatch = section.match(/(\|[^\n]+\|)\n(?=\n|$|##|---)/);
  if (tableEndMatch) {
    const insertPoint = section.lastIndexOf(tableEndMatch[1]) + tableEndMatch[1].length;
    const newSection = section.slice(0, insertPoint) + '\n' + newRow + section.slice(insertPoint);
    return content.replace(section, newSection);
  }

  return content;
}

/**
 * Generate complete index edits description for the orchestrator
 */
export function describeIndexEdits(edits: IndexEdit[]): string {
  let description = '## Index.md Updates Required\n\n';

  const groupedEdits = new Map<string, IndexEdit[]>();
  for (const edit of edits) {
    const existing = groupedEdits.get(edit.section) || [];
    existing.push(edit);
    groupedEdits.set(edit.section, existing);
  }

  for (const [section, sectionEdits] of groupedEdits) {
    description += `### ${section}\n\n`;
    for (const edit of sectionEdits) {
      description += `**${edit.action.toUpperCase()}:**\n\`\`\`\n${edit.content}\n\`\`\`\n\n`;
    }
  }

  return description;
}

// ============================================================================
// Atomic Index Operations
// ============================================================================

/**
 * Map category names to their section patterns and headers
 */
const CATEGORY_SECTION_MAP: Record<string, { pattern: RegExp; header: string }> = {
  'Backend': {
    pattern: /### Backend \(`docs\/backend\/`\)[\s\S]*?(?=\n### |\n---|\n## |$)/,
    header: '### Backend (`docs/backend/`)',
  },
  'Frontend': {
    pattern: /### Frontend \(`docs\/frontend\/`\)[\s\S]*?(?=\n### |\n---|\n## |$)/,
    header: '### Frontend (`docs/frontend/`)',
  },
  'API': {
    pattern: /### API Integrations[\s\S]*?(?=\n### |\n---|\n## |$)/,
    header: '### API Integrations (`docs/api/`)',
  },
  'Database': {
    pattern: /### Database \(`docs\/database\/`\)[\s\S]*?(?=\n### |\n---|\n## |$)/,
    header: '### Database (`docs/database/`)',
  },
  'Datapack': {
    pattern: /### Datapack[\s\S]*?(?=\n### |\n---|\n## |$)/,
    header: '### Datapack (`docs/datapack/`)',
  },
  'Guides': {
    pattern: /### Guides[\s\S]*?(?=\n### |\n---|\n## |$)/,
    header: '### Guides (`docs/guides/`)',
  },
  'Architecture': {
    pattern: /### Architecture[\s\S]*?(?=\n### |\n---|\n## |$)/,
    header: '### Architecture (`docs/architecture/`)',
  },
  'Meta': {
    pattern: /### Meta[\s\S]*?(?=\n### |\n---|\n## |$)/,
    header: '### Meta (`docs/meta/`)',
  },
};

/**
 * Source map section patterns based on path prefixes
 */
const SOURCE_MAP_SECTIONS: Record<string, { pattern: RegExp; header: string }> = {
  'src-tauri/src/core/': {
    pattern: /### Backend Core \(`src-tauri\/src\/core\/`\)[\s\S]*?(?=\n### |\n---|\n## |$)/,
    header: '### Backend Core (`src-tauri/src/core/`)',
  },
  'src/': {
    pattern: /### Frontend \(`src\/`\)[\s\S]*?(?=\n### |\n---|\n## |$)/,
    header: '### Frontend (`src/`)',
  },
  'src-tauri/migrations/': {
    pattern: /### Database \(`src-tauri\/migrations\/`\)[\s\S]*?(?=\n### |\n---|\n## |$)/,
    header: '### Database (`src-tauri/migrations/`)',
  },
};

/**
 * Find the appropriate source map section for a given source path
 */
function findSourceMapSection(sourcePath: string): { pattern: RegExp; header: string } | null {
  for (const [prefix, section] of Object.entries(SOURCE_MAP_SECTIONS)) {
    if (sourcePath.startsWith(prefix) || sourcePath.includes(prefix)) {
      return section;
    }
  }
  return SOURCE_MAP_SECTIONS['src-tauri/src/core/']; // Default to backend
}

/**
 * Add a row to a markdown table within a section
 */
function insertRowIntoTable(content: string, sectionPattern: RegExp, newRow: string): string {
  const match = content.match(sectionPattern);
  if (!match) {
    return content;
  }

  const section = match[0];
  const sectionStart = content.indexOf(section);

  // Find all table rows in the section (lines starting with |)
  const lines = section.split('\n');
  let lastTableRowIndex = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
      // Skip header separator row (|---|---|)
      if (!lines[i].includes('---')) {
        lastTableRowIndex = i;
        break;
      }
    }
  }

  if (lastTableRowIndex === -1) {
    // No table rows found, look for header row and add after separator
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('|---')) {
        lastTableRowIndex = i;
        break;
      }
    }
  }

  if (lastTableRowIndex !== -1) {
    lines.splice(lastTableRowIndex + 1, 0, newRow);
    const newSection = lines.join('\n');
    return content.slice(0, sectionStart) + newSection + content.slice(sectionStart + section.length);
  }

  return content;
}

/**
 * Remove a row from a markdown table that contains a specific path
 */
function removeRowFromTable(content: string, sectionPattern: RegExp, pathToRemove: string): string {
  const match = content.match(sectionPattern);
  if (!match) {
    return content;
  }

  const section = match[0];
  const lines = section.split('\n');
  const filteredLines = lines.filter(line => !line.includes(pathToRemove));

  if (filteredLines.length !== lines.length) {
    return content.replace(section, filteredLines.join('\n'));
  }

  return content;
}

/**
 * Replace all occurrences of an old path with a new path
 */
function replaceAllPaths(content: string, oldPath: string, newPath: string): string {
  // Escape special regex characters in the path
  const escaped = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'g');
  return content.replace(regex, newPath);
}

export interface ApplyResult {
  success: boolean;
  changes: string[];
  errors: string[];
  newContent: string;
}

/**
 * Apply index additions for a new document (atomic operation)
 */
export function applyIndexAdd(
  indexContent: string,
  docPath: string,
  docTitle: string,
  sources: string[],
  category: string,
  lastVerified: string
): ApplyResult {
  const changes: string[] = [];
  const errors: string[] = [];
  let content = indexContent;
  const today = new Date().toISOString().split('T')[0];
  const docFilename = path.basename(docPath);

  // 1. Add to Source to Documentation Map
  for (const source of sources) {
    const sourceSection = findSourceMapSection(source);
    if (sourceSection) {
      const row = formatSourceMapRow({
        sourceFile: source,
        docName: docTitle,
        docPath: docPath,
        lastVerified,
        trust: '✅',
        isCanonical: sources.indexOf(source) === 0, // First source is canonical
      });
      const newContent = insertRowIntoTable(content, sourceSection.pattern, row);
      if (newContent !== content) {
        content = newContent;
        changes.push(`Added source mapping: ${source} → ${docTitle}`);
      } else {
        errors.push(`Could not find section for source: ${source}`);
      }
    }
  }

  // 2. Add to Category section
  const categorySection = CATEGORY_SECTION_MAP[category];
  if (categorySection) {
    const row = formatCategoryRow({
      docFilename,
      docPath,
      status: 'current',
      lastVerified,
      trust: '✅',
    });
    const newContent = insertRowIntoTable(content, categorySection.pattern, row);
    if (newContent !== content) {
      content = newContent;
      changes.push(`Added to ${category} category`);
    } else {
      errors.push(`Could not find category section: ${category}`);
    }
  } else {
    errors.push(`Unknown category: ${category}`);
  }

  // 3. Add to Recently Verified
  const recentlyVerifiedPattern = /### Recently Verified[\s\S]*?(?=\n### |\n---|\n## |$)/;
  const recentRow = `| [${docFilename}](${docPath}) | ${today} | code-review | ✅ FRESH |`;
  const newContent = insertRowIntoTable(content, recentlyVerifiedPattern, recentRow);
  if (newContent !== content) {
    content = newContent;
    changes.push('Added to Recently Verified');
  }

  return {
    success: errors.length === 0,
    changes,
    errors,
    newContent: content,
  };
}

/**
 * Apply index updates for moving/renaming a document (atomic operation)
 */
export function applyIndexMove(
  indexContent: string,
  oldPath: string,
  newPath: string
): ApplyResult {
  const changes: string[] = [];
  const errors: string[] = [];
  let content = indexContent;
  const today = new Date().toISOString().split('T')[0];

  // 1. Add to Redirect Map
  const redirectMapPattern = /## Redirect Map \(Link Stability\)[\s\S]*?(?=\n---|\n## |$)/;
  const redirectRow = formatRedirectRow({
    oldPath: path.basename(oldPath),
    newPath,
    movedDate: today,
  });
  const newContent = insertRowIntoTable(content, redirectMapPattern, redirectRow);
  if (newContent !== content) {
    content = newContent;
    changes.push(`Added redirect: ${path.basename(oldPath)} → ${newPath}`);
  } else {
    errors.push('Could not add to Redirect Map');
  }

  // 2. Replace all occurrences of old path with new path
  const beforeReplace = content;
  content = replaceAllPaths(content, oldPath, newPath);
  if (content !== beforeReplace) {
    changes.push(`Updated all references from ${oldPath} to ${newPath}`);
  }

  return {
    success: errors.length === 0,
    changes,
    errors,
    newContent: content,
  };
}

/**
 * Apply index updates for archiving a document (atomic operation)
 */
export function applyIndexArchive(
  indexContent: string,
  docPath: string,
  archivePath: string,
  archiveReason: string
): ApplyResult {
  const changes: string[] = [];
  const errors: string[] = [];
  let content = indexContent;
  const today = new Date().toISOString().split('T')[0];
  const originalName = path.basename(docPath);
  const archivedName = path.basename(archivePath);

  // 1. Remove from category sections
  for (const [, categorySection] of Object.entries(CATEGORY_SECTION_MAP)) {
    const newContent = removeRowFromTable(content, categorySection.pattern, docPath);
    if (newContent !== content) {
      content = newContent;
      changes.push(`Removed from category table`);
      break;
    }
  }

  // 2. Add to Archive section
  const archivePattern = /### Archive \(`docs\/archive\/`\)[\s\S]*?(?=\n### |\n---|\n## |$)/;
  const archiveRow = formatArchiveRow({
    archivedName: archivedName.replace('.md', ''),
    archivePath,
    originalName,
    archiveDate: today,
    archiveType: archiveReason,
  });
  const newContent = insertRowIntoTable(content, archivePattern, archiveRow);
  if (newContent !== content) {
    content = newContent;
    changes.push(`Added to Archive section`);
  } else {
    errors.push('Could not add to Archive section');
  }

  // 3. Add to Redirect Map
  const redirectMapPattern = /## Redirect Map \(Link Stability\)[\s\S]*?(?=\n---|\n## |$)/;
  const redirectRow = formatRedirectRow({
    oldPath: originalName,
    newPath: archivePath,
    movedDate: today,
  });
  const newContent2 = insertRowIntoTable(content, redirectMapPattern, redirectRow);
  if (newContent2 !== content) {
    content = newContent2;
    changes.push(`Added redirect to archive`);
  }

  // 4. Remove from Source to Documentation Map
  for (const [, sourceSection] of Object.entries(SOURCE_MAP_SECTIONS)) {
    const newContent3 = removeRowFromTable(content, sourceSection.pattern, docPath);
    if (newContent3 !== content) {
      content = newContent3;
      changes.push(`Removed from Source Map`);
    }
  }

  return {
    success: true, // Archive is best-effort
    changes,
    errors,
    newContent: content,
  };
}

// ============================================================================
// Index Reconciliation
// ============================================================================

export interface ReconciliationResult {
  /** Docs in folder but not in index */
  orphanedDocs: Array<{
    filePath: string;
    title: string;
    suggestedCategory: string;
  }>;
  /** Index entries pointing to non-existent docs */
  staleIndexEntries: Array<{
    section: string;
    docPath: string;
    lineContent: string;
  }>;
  /** Summary stats */
  stats: {
    totalDocsInFolder: number;
    totalDocsInIndex: number;
    orphanedCount: number;
    staleCount: number;
  };
}

/**
 * Reconcile the index.md against the actual docs folder
 * Finds:
 * 1. Docs in folder that aren't referenced in index (orphaned)
 * 2. Index entries that point to docs that don't exist (stale)
 */
export function reconcileIndex(
  indexPath: string,
  docsRoot: string
): ReconciliationResult {
  const indexContent = fs.readFileSync(indexPath, 'utf-8');

  // 1. Scan docs folder for all .md files (excluding index.md, archive/, .backups/)
  const allDocFiles: string[] = [];
  function scanDir(dir: string, relativePath: string = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Skip archive and backup folders
        if (entry.name === 'archive' || entry.name === '.backups') continue;
        scanDir(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
        allDocFiles.push(relPath);
      }
    }
  }
  scanDir(docsRoot);

  // 2. Extract all doc paths referenced in index.md
  // Look for markdown links: [text](path.md) or [text](folder/path.md)
  const indexDocRefs = new Set<string>();
  const linkPattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  let match;
  while ((match = linkPattern.exec(indexContent)) !== null) {
    let docPath = match[2];
    // Normalize path - remove leading ./ or docs/
    docPath = docPath.replace(/^\.\//, '').replace(/^docs\//, '');
    indexDocRefs.add(docPath);
  }

  // 3. Find orphaned docs (in folder but not in index)
  const orphanedDocs: ReconciliationResult['orphanedDocs'] = [];
  for (const docFile of allDocFiles) {
    // Check various path formats that might appear in index
    const normalizedPath = docFile.replace(/\\/g, '/');
    const withDocsPrefix = `docs/${normalizedPath}`;
    const justFilename = path.basename(docFile);

    const isReferenced =
      indexDocRefs.has(normalizedPath) ||
      indexDocRefs.has(withDocsPrefix) ||
      indexDocRefs.has(`./${normalizedPath}`) ||
      // Check if the path appears anywhere in index content
      indexContent.includes(normalizedPath) ||
      indexContent.includes(withDocsPrefix);

    if (!isReferenced) {
      // Try to read frontmatter to get title
      let title = justFilename.replace('.md', '');
      try {
        const fullPath = path.join(docsRoot, docFile);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const titleMatch = content.match(/^title:\s*["']?([^"'\n]+)["']?/m);
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
      } catch {
        // Ignore read errors
      }

      // Infer category from path
      const pathParts = normalizedPath.split('/');
      let suggestedCategory = 'Backend'; // Default
      if (pathParts.length > 1) {
        const folder = pathParts[0].toLowerCase();
        const categoryMap: Record<string, string> = {
          'backend': 'Backend',
          'frontend': 'Frontend',
          'api': 'API',
          'database': 'Database',
          'datapack': 'Datapack',
          'guides': 'Guides',
          'architecture': 'Architecture',
          'meta': 'Meta',
        };
        suggestedCategory = categoryMap[folder] || 'Backend';
      }

      orphanedDocs.push({
        filePath: normalizedPath,
        title,
        suggestedCategory,
      });
    }
  }

  // 4. Find stale index entries (referenced in index but don't exist)
  const staleIndexEntries: ReconciliationResult['staleIndexEntries'] = [];
  const lines = indexContent.split('\n');
  const processedPaths = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLinkPattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
    let lineMatch;

    while ((lineMatch = lineLinkPattern.exec(line)) !== null) {
      let docPath = lineMatch[2];
      // Normalize
      docPath = docPath.replace(/^\.\//, '').replace(/^docs\//, '');

      // Skip if already processed or in archive
      if (processedPaths.has(docPath) || docPath.includes('archive/')) continue;
      processedPaths.add(docPath);

      // Check if file exists
      const fullPath = path.join(docsRoot, docPath);
      if (!fs.existsSync(fullPath)) {
        // Determine which section this is in
        let section = 'Unknown';
        for (let j = i; j >= 0; j--) {
          if (lines[j].startsWith('### ')) {
            section = lines[j].replace('### ', '').trim();
            break;
          } else if (lines[j].startsWith('## ')) {
            section = lines[j].replace('## ', '').trim();
            break;
          }
        }

        staleIndexEntries.push({
          section,
          docPath,
          lineContent: line.trim(),
        });
      }
    }
  }

  return {
    orphanedDocs,
    staleIndexEntries,
    stats: {
      totalDocsInFolder: allDocFiles.length,
      totalDocsInIndex: indexDocRefs.size,
      orphanedCount: orphanedDocs.length,
      staleCount: staleIndexEntries.length,
    },
  };
}

/**
 * Format reconciliation result as a readable report
 */
export function formatReconciliationReport(result: ReconciliationResult): string {
  let report = '# Index Reconciliation Report\n\n';

  report += '## Summary\n\n';
  report += `| Metric | Count |\n`;
  report += `|--------|-------|\n`;
  report += `| Docs in folder | ${result.stats.totalDocsInFolder} |\n`;
  report += `| Docs referenced in index | ${result.stats.totalDocsInIndex} |\n`;
  report += `| Orphaned docs (not in index) | ${result.stats.orphanedCount} |\n`;
  report += `| Stale index entries (file missing) | ${result.stats.staleCount} |\n`;
  report += '\n';

  if (result.stats.orphanedCount === 0 && result.stats.staleCount === 0) {
    report += '✅ **Index is in sync with docs folder!**\n';
    return report;
  }

  if (result.orphanedDocs.length > 0) {
    report += '## Orphaned Docs (not in index)\n\n';
    report += 'These docs exist in the folder but are not referenced in index.md:\n\n';
    report += '| File | Title | Suggested Category |\n';
    report += '|------|-------|-------------------|\n';
    for (const doc of result.orphanedDocs) {
      report += `| \`${doc.filePath}\` | ${doc.title} | ${doc.suggestedCategory} |\n`;
    }
    report += '\n';
    report += '**To fix:** Use `docs_index_apply` with operation="add" for each orphaned doc.\n\n';
  }

  if (result.staleIndexEntries.length > 0) {
    report += '## Stale Index Entries (file missing)\n\n';
    report += 'These entries in index.md reference docs that no longer exist:\n\n';
    report += '| Section | Doc Path | Line Content |\n';
    report += '|---------|----------|-------------|\n';
    for (const entry of result.staleIndexEntries) {
      const escapedLine = entry.lineContent.substring(0, 60).replace(/\|/g, '\\|');
      report += `| ${entry.section} | \`${entry.docPath}\` | ${escapedLine}... |\n`;
    }
    report += '\n';
    report += '**To fix:** Manually remove these entries from index.md, or use `docs_archive` if the doc was moved.\n\n';
  }

  return report;
}

// ============================================================================
// Index File Write Operations
// ============================================================================

/**
 * Apply index updates and write to file (full atomic operation)
 */
export function applyAndSaveIndex(
  indexPath: string,
  operation: 'add' | 'move' | 'archive',
  params: {
    docPath: string;
    docTitle?: string;
    sources?: string[];
    category?: string;
    lastVerified?: string;
    oldPath?: string;
    newPath?: string;
    archivePath?: string;
    archiveReason?: string;
  }
): ApplyResult {
  const indexContent = fs.readFileSync(indexPath, 'utf-8');
  let result: ApplyResult;

  switch (operation) {
    case 'add':
      if (!params.docTitle || !params.sources || !params.category) {
        return {
          success: false,
          changes: [],
          errors: ['Missing required params for add: docTitle, sources, category'],
          newContent: indexContent,
        };
      }
      result = applyIndexAdd(
        indexContent,
        params.docPath,
        params.docTitle,
        params.sources,
        params.category,
        params.lastVerified || new Date().toISOString().split('T')[0]
      );
      break;

    case 'move':
      if (!params.oldPath || !params.newPath) {
        return {
          success: false,
          changes: [],
          errors: ['Missing required params for move: oldPath, newPath'],
          newContent: indexContent,
        };
      }
      result = applyIndexMove(indexContent, params.oldPath, params.newPath);
      break;

    case 'archive':
      if (!params.archivePath || !params.archiveReason) {
        return {
          success: false,
          changes: [],
          errors: ['Missing required params for archive: archivePath, archiveReason'],
          newContent: indexContent,
        };
      }
      result = applyIndexArchive(
        indexContent,
        params.docPath,
        params.archivePath,
        params.archiveReason
      );
      break;

    default:
      return {
        success: false,
        changes: [],
        errors: [`Unknown operation: ${operation}`],
        newContent: indexContent,
      };
  }

  // Write the updated content
  if (result.success || result.changes.length > 0) {
    fs.writeFileSync(indexPath, result.newContent, 'utf-8');
  }

  return result;
}
