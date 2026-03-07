/**
 * Documentation Reorganization Analysis & Operations
 *
 * Philosophy: Provide SIGNALS that encourage documentation "gardening":
 * - Fewer, well-maintained docs are better than many neglected ones
 * - Docs should live in folders matching their actual type
 * - Overlapping docs should be consolidated
 * - Orphaned docs should be archived or deleted
 *
 * The MCP provides data; the LLM decides what to do.
 * All outputs are informational, not prescriptive.
 */

import * as fs from 'fs';
import * as path from 'path';
import { inferDocTypeFromPath, getDocTypeSignals } from './config.js';

// ============================================================================
// Types
// ============================================================================

export interface PlacementAnalysis {
  docPath: string;
  title: string;
  currentFolder: string;
  inferredTypeFromFolder: string | null;
  inferredTypeFromContent: string | null;
  contentSignals: string[];
  /** INFORMATIONAL: Suggests folder doesn't match content. LLM should verify. */
  possibleMisplacement: boolean;
  suggestedFolder: string | null;
  /** What the LLM should check before moving */
  verifyBefore: string;
}

export interface OverlapAnalysis {
  docs: Array<{
    path: string;
    title: string;
    sources: string[];
  }>;
  sharedSources: string[];
  overlapType: 'source-overlap' | 'title-similarity' | 'content-similarity';
  /** INFORMATIONAL: These docs may cover similar ground. LLM should review. */
  signal: string;
  /** What the LLM should consider */
  consolidationQuestions: string[];
}

export interface DocHealthSignal {
  docPath: string;
  title: string;
  signals: HealthSignal[];
  /** Overall health indicator - INFORMATIONAL, not a verdict */
  healthScore: 'healthy' | 'needs-attention' | 'candidate-for-removal';
  /** Actions the LLM might consider */
  possibleActions: string[];
}

export interface HealthSignal {
  type: 'orphan' | 'stale' | 'small' | 'no-sources' | 'duplicate-sources' | 'unlinked' | 'empty-sections';
  description: string;
  severity: 'info' | 'warning' | 'concern';
}

export interface ReorganizationReport {
  totalDocs: number;
  /** Docs that may be in the wrong folder */
  misplacedDocs: PlacementAnalysis[];
  /** Groups of docs that may overlap */
  overlappingDocs: OverlapAnalysis[];
  /** Docs with health concerns */
  healthConcerns: DocHealthSignal[];
  /** Summary statistics */
  summary: {
    possibleMisplacements: number;
    possibleOverlaps: number;
    removalCandidates: number;
    healthyDocs: number;
  };
  /** Gardening encouragement - informational */
  gardeningNotes: string[];
}

// ============================================================================
// Placement Analysis
// ============================================================================

/**
 * Analyze whether docs are in appropriate folders based on their content.
 *
 * INFORMATIONAL: Returns signals about potential misplacements.
 * The LLM should verify each suggestion makes sense before acting.
 */
export function analyzePlacement(
  docsRoot: string,
  parseDocFile: (filePath: string) => { frontmatter: Record<string, unknown> | null; content: string } | null
): PlacementAnalysis[] {
  const results: PlacementAnalysis[] = [];

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(docsRoot, fullPath);

      if (entry.isDirectory()) {
        // Skip special directories
        if (!['archive', '.backups', 'unmanaged', 'proposals', 'decisions'].includes(entry.name) &&
            !entry.name.startsWith('.')) {
          walkDir(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
        const parsed = parseDocFile(fullPath);
        if (!parsed) continue;

        const { frontmatter, content } = parsed;
        const title = (frontmatter?.title as string) || entry.name;

        // Get folder-based type inference
        const currentFolder = path.dirname(relativePath).split(path.sep)[0] || 'root';
        const inferredTypeFromFolder = inferDocTypeFromPath(relativePath);

        // Analyze content for type signals
        const contentSignals = analyzeContentForType(content, frontmatter);
        const inferredTypeFromContent = inferTypeFromContentSignals(contentSignals);

        // Check for potential misplacement
        let possibleMisplacement = false;
        let suggestedFolder: string | null = null;
        let verifyBefore = 'Read the document to confirm the type assessment is correct';

        if (inferredTypeFromContent && inferredTypeFromContent !== inferredTypeFromFolder) {
          // Content suggests different type than folder
          possibleMisplacement = true;
          suggestedFolder = inferredTypeFromContent === 'guide' ? 'guides' : inferredTypeFromContent;
          verifyBefore = `Verify this doc is actually a ${inferredTypeFromContent} doc, not a ${inferredTypeFromFolder} doc`;
        }

        // Only include docs with potential issues
        if (possibleMisplacement || contentSignals.length > 0) {
          results.push({
            docPath: relativePath,
            title,
            currentFolder,
            inferredTypeFromFolder,
            inferredTypeFromContent,
            contentSignals,
            possibleMisplacement,
            suggestedFolder,
            verifyBefore,
          });
        }
      }
    }
  }

  walkDir(docsRoot);
  return results.filter(r => r.possibleMisplacement);
}

/**
 * Analyze document content for type signals
 */
function analyzeContentForType(content: string, frontmatter: Record<string, unknown> | null): string[] {
  const signals: string[] = [];
  const lowerContent = content.toLowerCase();

  // Guide signals
  if (lowerContent.includes('## prerequisites') || lowerContent.includes('## step ') ||
      lowerContent.match(/## \d+\./)) {
    signals.push('has-prerequisites-or-steps');
  }
  if (lowerContent.includes('how to') || lowerContent.includes('tutorial') ||
      lowerContent.includes('walkthrough')) {
    signals.push('guide-language');
  }

  // API signals
  if (lowerContent.includes('## endpoints') || lowerContent.includes('## request') ||
      lowerContent.includes('## response')) {
    signals.push('api-structure');
  }
  if (lowerContent.match(/```json[\s\S]*?```/g)?.length ?? 0 > 2) {
    signals.push('multiple-json-examples');
  }

  // Architecture signals
  if (lowerContent.includes('## design') || lowerContent.includes('## trade-off') ||
      lowerContent.includes('## rationale')) {
    signals.push('architecture-language');
  }
  if (lowerContent.match(/```mermaid[\s\S]*?graph/)) {
    signals.push('has-architecture-diagram');
  }

  // Database signals
  if (lowerContent.includes('## schema') || lowerContent.includes('## table') ||
      lowerContent.includes('create table')) {
    signals.push('database-content');
  }

  // Frontend signals
  if (lowerContent.includes('## component') || lowerContent.includes('## props') ||
      lowerContent.includes('usestate') || lowerContent.includes('zustand')) {
    signals.push('frontend-content');
  }

  // Backend signals
  if (lowerContent.includes('## struct') || lowerContent.includes('pub fn') ||
      lowerContent.includes('tokio') || lowerContent.includes('async fn')) {
    signals.push('backend-rust-content');
  }

  return signals;
}

/**
 * Infer document type from content signals
 */
function inferTypeFromContentSignals(signals: string[]): string | null {
  // Strong guide signals
  if (signals.includes('has-prerequisites-or-steps') && signals.includes('guide-language')) {
    return 'guide';
  }
  if (signals.includes('has-prerequisites-or-steps')) {
    return 'guide';
  }

  // Strong API signals
  if (signals.includes('api-structure') && signals.includes('multiple-json-examples')) {
    return 'api';
  }

  // Strong architecture signals
  if (signals.includes('architecture-language') && signals.includes('has-architecture-diagram')) {
    return 'architecture';
  }

  // Strong database signals
  if (signals.includes('database-content')) {
    return 'database';
  }

  return null;
}

// ============================================================================
// Overlap Detection
// ============================================================================

/**
 * Find documents that may overlap in scope or content.
 *
 * INFORMATIONAL: Returns groups of docs that share sources or have similar titles.
 * Overlapping docs are candidates for consolidation.
 */
export function findOverlaps(
  docsRoot: string,
  parseDocFile: (filePath: string) => { frontmatter: Record<string, unknown> | null; content: string } | null
): OverlapAnalysis[] {
  const results: OverlapAnalysis[] = [];
  const docInfos: Array<{
    path: string;
    title: string;
    sources: string[];
    titleWords: Set<string>;
  }> = [];

  // Collect all doc info
  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(docsRoot, fullPath);

      if (entry.isDirectory()) {
        if (!['archive', '.backups', 'unmanaged'].includes(entry.name) &&
            !entry.name.startsWith('.')) {
          walkDir(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
        const parsed = parseDocFile(fullPath);
        if (!parsed?.frontmatter) continue;

        const title = (parsed.frontmatter.title as string) || entry.name;
        const sources = (parsed.frontmatter.sources as string[]) || [];

        // Extract significant words from title (ignore common words)
        const titleWords = new Set(
          title.toLowerCase()
            .split(/[\s\-_]+/)
            .filter(w => w.length > 3 && !['the', 'and', 'for', 'with', 'from'].includes(w))
        );

        docInfos.push({
          path: relativePath,
          title,
          sources,
          titleWords,
        });
      }
    }
  }

  walkDir(docsRoot);

  // Find source overlaps
  const sourceToDoc = new Map<string, string[]>();
  for (const doc of docInfos) {
    for (const source of doc.sources) {
      const existing = sourceToDoc.get(source) || [];
      existing.push(doc.path);
      sourceToDoc.set(source, existing);
    }
  }

  // Group docs with shared sources
  const processedPairs = new Set<string>();
  for (const [source, docPaths] of sourceToDoc) {
    if (docPaths.length > 1) {
      const pairKey = docPaths.sort().join('|');
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);

      // Find all shared sources for this doc group
      const docsInGroup = docInfos.filter(d => docPaths.includes(d.path));
      const allSharedSources: string[] = [];

      for (const [s, paths] of sourceToDoc) {
        if (paths.length > 1 && paths.every(p => docPaths.includes(p))) {
          allSharedSources.push(s);
        }
      }

      if (allSharedSources.length > 0) {
        results.push({
          docs: docsInGroup.map(d => ({ path: d.path, title: d.title, sources: d.sources })),
          sharedSources: allSharedSources,
          overlapType: 'source-overlap',
          signal: `${docsInGroup.length} docs share ${allSharedSources.length} source file(s)`,
          consolidationQuestions: [
            'Do these docs cover the same functionality from different angles?',
            'Could one doc be expanded to cover what the others document?',
            'Are these legitimately separate concerns (e.g., frontend vs backend)?',
            'Would readers benefit from having this in one place?',
          ],
        });
      }
    }
  }

  // Find title similarity (docs with similar names might cover similar topics)
  for (let i = 0; i < docInfos.length; i++) {
    for (let j = i + 1; j < docInfos.length; j++) {
      const doc1 = docInfos[i];
      const doc2 = docInfos[j];

      // Skip if already found via source overlap
      const pairKey = [doc1.path, doc2.path].sort().join('|');
      if (processedPairs.has(pairKey)) continue;

      // Check title word overlap
      const intersection = new Set([...doc1.titleWords].filter(w => doc2.titleWords.has(w)));
      const similarity = intersection.size / Math.min(doc1.titleWords.size, doc2.titleWords.size);

      if (similarity >= 0.5 && intersection.size >= 2) {
        processedPairs.add(pairKey);
        results.push({
          docs: [
            { path: doc1.path, title: doc1.title, sources: doc1.sources },
            { path: doc2.path, title: doc2.title, sources: doc2.sources },
          ],
          sharedSources: [],
          overlapType: 'title-similarity',
          signal: `Similar titles: "${doc1.title}" and "${doc2.title}" (shared words: ${[...intersection].join(', ')})`,
          consolidationQuestions: [
            'Are these docs covering the same topic?',
            'Is one a subset of the other?',
            'Should one reference the other instead of duplicating?',
          ],
        });
      }
    }
  }

  return results;
}

// ============================================================================
// Health Analysis
// ============================================================================

/**
 * Analyze documentation health and identify candidates for removal/consolidation.
 *
 * INFORMATIONAL: Returns signals about doc health.
 * Encourages "gardening" - fewer well-maintained docs > many neglected ones.
 */
export function analyzeHealth(
  docsRoot: string,
  indexContent: string,
  parseDocFile: (filePath: string) => { frontmatter: Record<string, unknown> | null; content: string } | null
): DocHealthSignal[] {
  const results: DocHealthSignal[] = [];

  // Build set of docs referenced in index
  const indexRefs = new Set<string>();
  const indexLower = indexContent.toLowerCase();
  const linkPattern = /\[.*?\]\((.*?\.md)\)/g;
  let match;
  while ((match = linkPattern.exec(indexLower)) !== null) {
    indexRefs.add(match[1].replace(/^\.\//, ''));
  }

  // Build set of docs that reference other docs (for orphan detection)
  const incomingLinks = new Map<string, string[]>();

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(docsRoot, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (!['archive', '.backups', 'unmanaged'].includes(entry.name) &&
            !entry.name.startsWith('.')) {
          walkDir(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
        const parsed = parseDocFile(fullPath);
        if (!parsed) continue;

        const { frontmatter, content } = parsed;
        const title = (frontmatter?.title as string) || entry.name;
        const signals: HealthSignal[] = [];
        const possibleActions: string[] = [];

        // Check: No sources defined
        const sources = (frontmatter?.sources as string[]) || [];
        if (sources.length === 0) {
          signals.push({
            type: 'no-sources',
            description: 'No source files linked - doc may be orphaned from codebase',
            severity: 'warning',
          });
          possibleActions.push('Add source files or consider if this doc is still needed');
        }

        // Check: Not in index
        const inIndex = indexRefs.has(relativePath.toLowerCase()) ||
                       indexRefs.has(relativePath.toLowerCase().replace(/\//g, '\\'));
        if (!inIndex) {
          signals.push({
            type: 'orphan',
            description: 'Not referenced in index.md',
            severity: 'warning',
          });
          possibleActions.push('Add to index.md or archive if no longer needed');
        }

        // Check: Very small content
        const contentLines = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
        if (contentLines < 10) {
          signals.push({
            type: 'small',
            description: `Very little content (${contentLines} non-header lines)`,
            severity: 'concern',
          });
          possibleActions.push('Expand content or merge into related doc');
        }

        // Check: Empty/stub sections
        const stubPatterns = [
          /## .*?\n+(?:TODO|TBD|WIP|Coming soon)/i,
          /## .*?\n+\s*\n+##/,
        ];
        for (const pattern of stubPatterns) {
          if (pattern.test(content)) {
            signals.push({
              type: 'empty-sections',
              description: 'Contains empty or stub sections',
              severity: 'info',
            });
            possibleActions.push('Complete stub sections or remove if not needed');
            break;
          }
        }

        // Check: No related-docs (unlinked)
        const relatedDocs = (frontmatter?.['related-docs'] as string[]) || [];
        const dependsOn = (frontmatter?.['depends-on'] as string[]) || [];
        if (relatedDocs.length === 0 && dependsOn.length === 0) {
          signals.push({
            type: 'unlinked',
            description: 'No links to other docs (isolated)',
            severity: 'info',
          });
          possibleActions.push('Add related-docs links to improve navigation');
        }

        // Determine overall health
        let healthScore: 'healthy' | 'needs-attention' | 'candidate-for-removal' = 'healthy';
        const concernCount = signals.filter(s => s.severity === 'concern').length;
        const warningCount = signals.filter(s => s.severity === 'warning').length;

        if (concernCount >= 2 || (concernCount >= 1 && warningCount >= 2)) {
          healthScore = 'candidate-for-removal';
          possibleActions.unshift('Consider archiving or merging this document');
        } else if (warningCount >= 1 || concernCount >= 1) {
          healthScore = 'needs-attention';
        }

        // Only include docs with signals
        if (signals.length > 0) {
          results.push({
            docPath: relativePath,
            title,
            signals,
            healthScore,
            possibleActions,
          });
        }
      }
    }
  }

  walkDir(docsRoot);

  // Sort by health score (worst first)
  const scoreOrder = { 'candidate-for-removal': 0, 'needs-attention': 1, 'healthy': 2 };
  results.sort((a, b) => scoreOrder[a.healthScore] - scoreOrder[b.healthScore]);

  return results;
}

// ============================================================================
// Full Reorganization Report
// ============================================================================

/**
 * Generate a comprehensive reorganization report.
 *
 * INFORMATIONAL: Provides signals and suggestions for documentation gardening.
 * The report encourages consolidation and removal of unnecessary docs.
 */
export function generateReorganizationReport(
  docsRoot: string,
  indexPath: string,
  parseDocFile: (filePath: string) => { frontmatter: Record<string, unknown> | null; content: string } | null
): ReorganizationReport {
  const indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '';

  const misplacedDocs = analyzePlacement(docsRoot, parseDocFile);
  const overlappingDocs = findOverlaps(docsRoot, parseDocFile);
  const healthConcerns = analyzeHealth(docsRoot, indexContent, parseDocFile);

  // Count total docs
  let totalDocs = 0;
  function countDocs(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !['archive', '.backups', 'unmanaged'].includes(entry.name) &&
          !entry.name.startsWith('.')) {
        countDocs(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
        totalDocs++;
      }
    }
  }
  countDocs(docsRoot);

  const removalCandidates = healthConcerns.filter(h => h.healthScore === 'candidate-for-removal').length;
  const healthyDocs = totalDocs - healthConcerns.length;

  // Generate gardening notes
  const gardeningNotes: string[] = [];

  if (totalDocs > 30) {
    gardeningNotes.push(`You have ${totalDocs} docs. Consider whether all are needed - fewer well-maintained docs are better than many neglected ones.`);
  }

  if (overlappingDocs.length > 0) {
    gardeningNotes.push(`Found ${overlappingDocs.length} potential overlap(s). Consolidating reduces maintenance burden and helps readers find information.`);
  }

  if (removalCandidates > 0) {
    gardeningNotes.push(`${removalCandidates} doc(s) show multiple health concerns. Archive or merge docs that aren't actively maintained.`);
  }

  if (misplacedDocs.length > 0) {
    gardeningNotes.push(`${misplacedDocs.length} doc(s) may be in the wrong folder. Proper organization helps readers and AI agents find docs.`);
  }

  const orphanCount = healthConcerns.filter(h => h.signals.some(s => s.type === 'orphan')).length;
  if (orphanCount > 0) {
    gardeningNotes.push(`${orphanCount} doc(s) aren't in the index. Orphaned docs are hard to discover - add to index or archive.`);
  }

  if (gardeningNotes.length === 0) {
    gardeningNotes.push('Documentation looks well-organized! Keep up the gardening.');
  }

  return {
    totalDocs,
    misplacedDocs,
    overlappingDocs,
    healthConcerns,
    summary: {
      possibleMisplacements: misplacedDocs.length,
      possibleOverlaps: overlappingDocs.length,
      removalCandidates,
      healthyDocs,
    },
    gardeningNotes,
  };
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Move a document file and update all references.
 *
 * This is an ATOMIC operation that:
 * 1. Creates backup of original
 * 2. Moves the file
 * 3. Updates index.md
 * 4. Finds and reports cross-references that need updating
 */
export function moveDocFile(
  docsRoot: string,
  oldPath: string,
  newPath: string,
  updateIndex: (oldPath: string, newPath: string) => void
): {
  success: boolean;
  backupPath?: string;
  crossRefsToUpdate: Array<{ file: string; line: number; content: string }>;
  error?: string;
} {
  const fullOldPath = path.join(docsRoot, oldPath);
  const fullNewPath = path.join(docsRoot, newPath);

  // Validate
  if (!fs.existsSync(fullOldPath)) {
    return { success: false, crossRefsToUpdate: [], error: `Source file not found: ${oldPath}` };
  }
  if (fs.existsSync(fullNewPath)) {
    return { success: false, crossRefsToUpdate: [], error: `Target already exists: ${newPath}` };
  }

  // Create backup
  const backupDir = path.join(docsRoot, '.backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${path.basename(oldPath, '.md')}.pre-move.${timestamp}.md`;
  const backupPath = path.join(backupDir, backupName);
  fs.copyFileSync(fullOldPath, backupPath);

  // Find cross-references before moving
  const crossRefsToUpdate: Array<{ file: string; line: number; content: string }> = [];
  function findRefs(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'archive') {
        findRefs(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(oldPath) || lines[i].includes(oldPath.replace(/\//g, '\\'))) {
            crossRefsToUpdate.push({
              file: path.relative(docsRoot, fullPath),
              line: i + 1,
              content: lines[i].trim(),
            });
          }
        }
      }
    }
  }
  findRefs(docsRoot);

  // Ensure target directory exists
  const targetDir = path.dirname(fullNewPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Move the file
  fs.renameSync(fullOldPath, fullNewPath);

  // Update index
  try {
    updateIndex(oldPath, newPath);
  } catch (e) {
    // Rollback on index update failure
    fs.renameSync(fullNewPath, fullOldPath);
    return { success: false, crossRefsToUpdate: [], error: `Index update failed: ${e}` };
  }

  return {
    success: true,
    backupPath: path.relative(docsRoot, backupPath),
    crossRefsToUpdate,
  };
}

/**
 * Delete a document (moves to archive with deletion metadata).
 *
 * We don't truly delete - we archive with reason 'obsolete'.
 * This preserves history and allows recovery.
 */
export function deleteDocFile(
  docsRoot: string,
  docPath: string,
  reason: string,
  archiveDoc: (docPath: string, reason: string, notes?: string) => { success: boolean; error?: string }
): {
  success: boolean;
  archivedTo?: string;
  error?: string;
} {
  // Use archive with obsolete reason
  const result = archiveDoc(docPath, 'obsolete', `Deleted: ${reason}`);

  if (result.success) {
    const archivedName = `${new Date().toISOString().split('T')[0]}-archived-${path.basename(docPath)}`;
    return {
      success: true,
      archivedTo: `archive/${archivedName}`,
    };
  }

  return { success: false, error: result.error };
}

/**
 * Merge multiple documents into one.
 *
 * This operation:
 * 1. Creates a new merged document (or uses target if specified)
 * 2. Archives the source documents with reason 'restructured'
 * 3. Updates index
 * 4. Reports cross-references to update
 */
export function mergeDocFiles(
  docsRoot: string,
  sourcePaths: string[],
  targetPath: string,
  mergedContent: string,
  archiveDoc: (docPath: string, reason: string, notes?: string) => { success: boolean; error?: string }
): {
  success: boolean;
  archivedDocs: string[];
  crossRefsToUpdate: Array<{ file: string; references: string[] }>;
  error?: string;
} {
  const fullTargetPath = path.join(docsRoot, targetPath);
  const archivedDocs: string[] = [];
  const crossRefsToUpdate: Array<{ file: string; references: string[] }> = [];

  // Validate source files exist
  for (const sourcePath of sourcePaths) {
    const fullSourcePath = path.join(docsRoot, sourcePath);
    if (!fs.existsSync(fullSourcePath)) {
      return { success: false, archivedDocs: [], crossRefsToUpdate: [], error: `Source not found: ${sourcePath}` };
    }
  }

  // Find cross-references to source docs
  function findRefs(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'archive') {
        findRefs(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const relPath = path.relative(docsRoot, fullPath);
        const refs: string[] = [];

        for (const sourcePath of sourcePaths) {
          if (content.includes(sourcePath) || content.includes(sourcePath.replace(/\//g, '\\'))) {
            refs.push(sourcePath);
          }
        }

        if (refs.length > 0 && !sourcePaths.includes(relPath)) {
          crossRefsToUpdate.push({ file: relPath, references: refs });
        }
      }
    }
  }
  findRefs(docsRoot);

  // Ensure target directory exists
  const targetDir = path.dirname(fullTargetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Write merged content
  fs.writeFileSync(fullTargetPath, mergedContent, 'utf-8');

  // Archive source documents
  for (const sourcePath of sourcePaths) {
    if (sourcePath === targetPath) continue; // Don't archive the target if it was also a source

    const result = archiveDoc(sourcePath, 'restructured', `Merged into ${targetPath}`);
    if (result.success) {
      archivedDocs.push(sourcePath);
    }
  }

  return {
    success: true,
    archivedDocs,
    crossRefsToUpdate,
  };
}
