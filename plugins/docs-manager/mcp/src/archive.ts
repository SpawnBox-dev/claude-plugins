/**
 * Archive Manager
 *
 * Handles documentation archival workflow:
 * - Moving deprecated/obsolete docs to archive folder
 * - Adding archive metadata and redirect entries
 * - Updating index.md with archive records
 * - Archive naming conventions
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { backupFileBeforeArchive } from './backup.js';
import { generateArchiveEdits, formatRedirectRow, formatArchiveRow } from './index-manager.js';

// ============================================================================
// Types
// ============================================================================

export type ArchiveReason =
  | 'obsolete' // Code no longer exists
  | 'superseded' // Replaced by newer doc
  | 'deprecated' // Feature deprecated
  | 'investigation-complete' // Investigation doc concluded
  | 'restructured'; // Content merged elsewhere

export interface ArchiveRequest {
  docPath: string; // Relative to docs root
  reason: ArchiveReason;
  supersededBy?: string; // Path to replacement doc if applicable
  notes?: string; // Additional context
}

export interface ArchiveResult {
  success: boolean;
  archivedPath?: string;
  redirectEntry?: string;
  archiveEntry?: string;
  indexEdits?: string[];
  error?: string;
}

export interface ArchiveMetadata {
  originalPath: string;
  archivedDate: string;
  reason: ArchiveReason;
  supersededBy?: string;
  notes?: string;
}

// ============================================================================
// Archive Operations
// ============================================================================

/**
 * Archive a documentation file
 *
 * This performs:
 * 1. Pre-archive backup
 * 2. Add archive metadata to frontmatter
 * 3. Move to archive folder with dated name
 * 4. Generate index.md update instructions
 */
export function archiveDocument(
  docsRoot: string,
  request: ArchiveRequest
): ArchiveResult {
  const { docPath, reason, supersededBy, notes } = request;
  const fullPath = path.join(docsRoot, docPath);

  try {
    // Validate source exists
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `Document not found: ${docPath}` };
    }

    // Create backup before archiving
    const backupResult = backupFileBeforeArchive(
      docsRoot,
      fullPath,
      `Archiving: ${reason}${supersededBy ? ` (superseded by ${supersededBy})` : ''}`
    );

    if (!backupResult.success) {
      return { success: false, error: `Backup failed: ${backupResult.error}` };
    }

    // Read current content
    const content = fs.readFileSync(fullPath, 'utf-8');

    // Add archive metadata to frontmatter
    const updatedContent = addArchiveMetadata(content, {
      originalPath: docPath,
      archivedDate: new Date().toISOString().split('T')[0],
      reason,
      supersededBy,
      notes,
    });

    // Generate archive filename and path
    const archiveFilename = generateArchiveFilename(path.basename(docPath));
    const archiveDir = path.join(docsRoot, 'archive');
    const archivePath = path.join(archiveDir, archiveFilename);

    // Ensure archive directory exists
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    // Write to archive location
    fs.writeFileSync(archivePath, updatedContent);

    // Remove original file
    fs.unlinkSync(fullPath);

    // Generate index update instructions
    const relativeArchivePath = path.relative(docsRoot, archivePath);
    const indexEdits = generateArchiveEdits(docPath, relativeArchivePath, reason);

    // Generate formatted entries for easy copy-paste
    const redirectEntry = formatRedirectRow({
      oldPath: path.basename(docPath),
      newPath: relativeArchivePath,
      movedDate: new Date().toISOString().split('T')[0],
    });

    const archiveEntry = formatArchiveRow({
      archivedName: path.basename(archiveFilename, '.md'),
      archivePath: relativeArchivePath,
      originalName: path.basename(docPath),
      archiveDate: new Date().toISOString().split('T')[0],
      archiveType: reason,
    });

    return {
      success: true,
      archivedPath: relativeArchivePath,
      redirectEntry,
      archiveEntry,
      indexEdits: indexEdits.map((e) => `${e.section}: ${e.action} - ${e.content}`),
    };
  } catch (error) {
    return { success: false, error: `Archive failed: ${error}` };
  }
}

/**
 * Restore a document from archive
 */
export function restoreFromArchive(
  docsRoot: string,
  archivePath: string,
  targetPath?: string
): ArchiveResult {
  const fullArchivePath = path.join(docsRoot, archivePath);

  try {
    if (!fs.existsSync(fullArchivePath)) {
      return { success: false, error: `Archive file not found: ${archivePath}` };
    }

    // Read archived content
    const content = fs.readFileSync(fullArchivePath, 'utf-8');

    // Extract original path from archive metadata or use provided target
    const metadata = extractArchiveMetadata(content);
    const restorePath = targetPath || metadata?.originalPath;

    if (!restorePath) {
      return {
        success: false,
        error: 'Cannot determine restore path. Please provide targetPath.',
      };
    }

    const fullRestorePath = path.join(docsRoot, restorePath);

    // Check if target already exists
    if (fs.existsSync(fullRestorePath)) {
      return {
        success: false,
        error: `Target path already exists: ${restorePath}. Please remove or rename first.`,
      };
    }

    // Remove archive metadata from frontmatter
    const restoredContent = removeArchiveMetadata(content);

    // Update status back to current
    const updatedContent = updateStatusForRestore(restoredContent);

    // Ensure target directory exists
    const targetDir = path.dirname(fullRestorePath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Write restored file
    fs.writeFileSync(fullRestorePath, updatedContent);

    // Remove from archive
    fs.unlinkSync(fullArchivePath);

    return {
      success: true,
      archivedPath: restorePath,
      indexEdits: [
        `Remove from Archive section: ${archivePath}`,
        `Remove redirect entry for: ${path.basename(restorePath)}`,
        `Add back to appropriate category section`,
      ],
    };
  } catch (error) {
    return { success: false, error: `Restore failed: ${error}` };
  }
}

/**
 * List all archived documents
 */
export function listArchived(docsRoot: string): Array<{
  path: string;
  metadata: ArchiveMetadata | null;
}> {
  const archiveDir = path.join(docsRoot, 'archive');

  if (!fs.existsSync(archiveDir)) {
    return [];
  }

  const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.md'));

  return files.map((file) => {
    const filePath = path.join(archiveDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const metadata = extractArchiveMetadata(content);

    return {
      path: path.relative(docsRoot, filePath),
      metadata,
    };
  });
}

/**
 * Find documents that match patterns often associated with archival candidates.
 *
 * INFORMATIONAL: This provides pattern matches, not archival decisions.
 * The calling LLM should:
 * - Review each candidate to determine if archival is appropriate
 * - Consider whether deprecated docs are still referenced by other docs
 * - Verify investigation docs are actually complete before archiving
 * - Check if confidence=n/a is intentional or indicates a problem
 *
 * Only the LLM (with full context) can decide if a doc should be archived.
 * These are signals, not prescriptions.
 */
export function suggestArchiveCandidates(
  docsRoot: string,
  parseDocFrontmatter: (content: string) => Record<string, unknown> | null
): Array<{
  path: string;
  /** Pattern that matched - descriptive, not prescriptive */
  signal: string;
  /** Suggested type IF archival is appropriate - LLM should verify */
  possibleArchiveType: ArchiveReason;
  /** What the LLM should check before archiving */
  verifyBefore: string;
}> {
  const candidates: Array<{
    path: string;
    signal: string;
    possibleArchiveType: ArchiveReason;
    verifyBefore: string;
  }> = [];

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip archive, backups, and hidden directories
        if (!['archive', '.backups'].includes(entry.name) && !entry.name.startsWith('.')) {
          walkDir(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const frontmatter = parseDocFrontmatter(content);

        if (frontmatter) {
          // Pattern: status=deprecated
          if (frontmatter.status === 'deprecated') {
            candidates.push({
              path: path.relative(docsRoot, fullPath),
              signal: 'Frontmatter status is "deprecated"',
              possibleArchiveType: 'deprecated',
              verifyBefore: 'Check if other docs reference this one; ensure deprecation is intentional',
            });
          }

          // Pattern: status=historical-investigation
          if (frontmatter.status === 'historical-investigation') {
            candidates.push({
              path: path.relative(docsRoot, fullPath),
              signal: 'Frontmatter status is "historical-investigation"',
              possibleArchiveType: 'investigation-complete',
              verifyBefore: 'Read the doc to confirm investigation is complete and findings are preserved',
            });
          }

          // Pattern: confidence=n/a (excluding proposals which intentionally have n/a)
          if (frontmatter.confidence === 'n/a' && frontmatter.status !== 'proposal') {
            candidates.push({
              path: path.relative(docsRoot, fullPath),
              signal: 'Frontmatter confidence is "n/a" (not a proposal)',
              possibleArchiveType: 'obsolete',
              verifyBefore: 'Determine if n/a confidence means obsolete or just unverified',
            });
          }
        }
      }
    }
  }

  walkDir(docsRoot);
  return candidates;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate archive filename with date prefix
 */
function generateArchiveFilename(originalFilename: string): string {
  const today = new Date().toISOString().split('T')[0];
  const ext = path.extname(originalFilename);
  const base = path.basename(originalFilename, ext);

  // If already has a date prefix, replace it
  const datePattern = /^\d{4}-\d{2}-\d{2}-/;
  if (datePattern.test(base)) {
    const nameWithoutDate = base.replace(datePattern, '');
    return `${today}-archived-${nameWithoutDate}${ext}`;
  }

  return `${today}-archived-${base}${ext}`;
}

/**
 * Add archive metadata to document frontmatter
 */
function addArchiveMetadata(content: string, metadata: ArchiveMetadata): string {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

  if (!frontmatterMatch) {
    // No frontmatter, add it
    const archiveBlock = `---
# === ARCHIVE METADATA ===
archived: true
archived-date: ${metadata.archivedDate}
archive-reason: ${metadata.reason}
original-path: ${metadata.originalPath}
${metadata.supersededBy ? `superseded-by: ${metadata.supersededBy}` : ''}
${metadata.notes ? `archive-notes: "${metadata.notes}"` : ''}

status: deprecated
---

`;
    return archiveBlock + content;
  }

  // Add archive section to existing frontmatter
  const existingFrontmatter = frontmatterMatch[1];
  const archiveSection = `
# === ARCHIVE METADATA ===
archived: true
archived-date: ${metadata.archivedDate}
archive-reason: ${metadata.reason}
original-path: ${metadata.originalPath}
${metadata.supersededBy ? `superseded-by: ${metadata.supersededBy}` : ''}
${metadata.notes ? `archive-notes: "${metadata.notes}"` : ''}`;

  // Also update status to deprecated if not already
  let updatedFrontmatter = existingFrontmatter;
  if (!updatedFrontmatter.includes('status: deprecated')) {
    updatedFrontmatter = updatedFrontmatter.replace(
      /status:\s*\w+/,
      'status: deprecated'
    );
  }

  return content.replace(
    /^---\n([\s\S]*?)\n---/,
    `---\n${updatedFrontmatter}${archiveSection}\n---`
  );
}

/**
 * Extract archive metadata from frontmatter
 */
function extractArchiveMetadata(content: string): ArchiveMetadata | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

  if (!frontmatterMatch) {
    return null;
  }

  try {
    const parsed = yaml.parse(frontmatterMatch[1]) as Record<string, unknown>;

    if (!parsed.archived) {
      return null;
    }

    return {
      originalPath: parsed['original-path'] as string,
      archivedDate: parsed['archived-date'] as string,
      reason: parsed['archive-reason'] as ArchiveReason,
      supersededBy: parsed['superseded-by'] as string | undefined,
      notes: parsed['archive-notes'] as string | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Remove archive metadata from frontmatter
 */
function removeArchiveMetadata(content: string): string {
  // Remove the archive metadata section
  let result = content.replace(
    /\n# === ARCHIVE METADATA ===[\s\S]*?(?=\n# ===|\n---)/,
    ''
  );

  // Remove individual archive fields if they exist outside the section
  const archiveFields = [
    'archived:',
    'archived-date:',
    'archive-reason:',
    'original-path:',
    'superseded-by:',
    'archive-notes:',
  ];

  for (const field of archiveFields) {
    result = result.replace(new RegExp(`^${field}.*$\\n?`, 'gm'), '');
  }

  return result;
}

/**
 * Update status for restored document
 */
function updateStatusForRestore(content: string): string {
  // Change status from deprecated back to draft (needs verification)
  return content.replace(/status:\s*deprecated/, 'status: draft');
}
