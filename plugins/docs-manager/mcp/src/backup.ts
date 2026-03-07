/**
 * Backup Manager
 *
 * Handles documentation backup operations:
 * - Snapshot backups (full docs folder)
 * - Individual file backups before edits
 * - Backup rotation and cleanup
 * - Restore operations
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface BackupEntry {
  id: string;
  timestamp: Date;
  type: 'snapshot' | 'pre-edit' | 'pre-archive';
  sourcePath: string;
  backupPath: string;
  reason: string;
  fileCount?: number;
}

export interface BackupConfig {
  backupDir: string;
  maxSnapshots: number;
  maxFileBackups: number;
  retentionDays: number;
}

export interface BackupResult {
  success: boolean;
  backupEntry?: BackupEntry;
  error?: string;
}

export interface RestoreResult {
  success: boolean;
  restoredPath?: string;
  error?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: BackupConfig = {
  backupDir: '.backups',
  maxSnapshots: 5,
  maxFileBackups: 10,
  retentionDays: 30,
};

// ============================================================================
// Backup Operations
// ============================================================================

/**
 * Create a pre-edit backup of a single file
 * This should be called before any modification to a doc
 */
export function backupFileBeforeEdit(
  docsRoot: string,
  filePath: string,
  reason: string,
  config: Partial<BackupConfig> = {}
): BackupResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const backupDir = path.join(docsRoot, cfg.backupDir);

  try {
    // Ensure backup directory exists
    ensureDir(backupDir);

    // Generate backup filename with timestamp
    const timestamp = new Date();
    const filename = path.basename(filePath);
    const backupFilename = generateBackupFilename(filename, timestamp, 'pre-edit');
    const backupPath = path.join(backupDir, backupFilename);

    // Copy file to backup location
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `Source file not found: ${filePath}` };
    }

    fs.copyFileSync(filePath, backupPath);

    // Create backup entry
    const entry: BackupEntry = {
      id: generateBackupId(),
      timestamp,
      type: 'pre-edit',
      sourcePath: path.relative(docsRoot, filePath),
      backupPath: path.relative(docsRoot, backupPath),
      reason,
    };

    // Write manifest entry
    appendToManifest(backupDir, entry);

    // Cleanup old backups for this file
    cleanupFileBackups(backupDir, filename, cfg.maxFileBackups);

    return { success: true, backupEntry: entry };
  } catch (error) {
    return { success: false, error: `Backup failed: ${error}` };
  }
}

/**
 * Create a pre-archive backup of a file before moving to archive
 */
export function backupFileBeforeArchive(
  docsRoot: string,
  filePath: string,
  archiveReason: string,
  config: Partial<BackupConfig> = {}
): BackupResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const backupDir = path.join(docsRoot, cfg.backupDir);

  try {
    ensureDir(backupDir);

    const timestamp = new Date();
    const filename = path.basename(filePath);
    const backupFilename = generateBackupFilename(filename, timestamp, 'pre-archive');
    const backupPath = path.join(backupDir, backupFilename);

    if (!fs.existsSync(filePath)) {
      return { success: false, error: `Source file not found: ${filePath}` };
    }

    fs.copyFileSync(filePath, backupPath);

    const entry: BackupEntry = {
      id: generateBackupId(),
      timestamp,
      type: 'pre-archive',
      sourcePath: path.relative(docsRoot, filePath),
      backupPath: path.relative(docsRoot, backupPath),
      reason: archiveReason,
    };

    appendToManifest(backupDir, entry);

    return { success: true, backupEntry: entry };
  } catch (error) {
    return { success: false, error: `Backup failed: ${error}` };
  }
}

/**
 * Create a full snapshot of the docs folder
 * Useful before major reorganizations or bulk updates
 */
export function createSnapshot(
  docsRoot: string,
  reason: string,
  config: Partial<BackupConfig> = {}
): BackupResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const backupDir = path.join(docsRoot, cfg.backupDir);

  try {
    ensureDir(backupDir);

    const timestamp = new Date();
    const snapshotDirName = `snapshot-${formatTimestamp(timestamp)}`;
    const snapshotPath = path.join(backupDir, snapshotDirName);

    // Create snapshot directory
    fs.mkdirSync(snapshotPath, { recursive: true });

    // Copy all markdown files (excluding .backups)
    const filesCopied = copyDocsRecursively(docsRoot, snapshotPath, cfg.backupDir);

    const entry: BackupEntry = {
      id: generateBackupId(),
      timestamp,
      type: 'snapshot',
      sourcePath: '.',
      backupPath: path.relative(docsRoot, snapshotPath),
      reason,
      fileCount: filesCopied,
    };

    appendToManifest(backupDir, entry);

    // Cleanup old snapshots
    cleanupSnapshots(backupDir, cfg.maxSnapshots);

    return { success: true, backupEntry: entry };
  } catch (error) {
    return { success: false, error: `Snapshot failed: ${error}` };
  }
}

/**
 * Restore a file from backup
 */
export function restoreFromBackup(
  docsRoot: string,
  backupPath: string,
  targetPath?: string
): RestoreResult {
  try {
    const fullBackupPath = path.join(docsRoot, backupPath);

    if (!fs.existsSync(fullBackupPath)) {
      return { success: false, error: `Backup not found: ${backupPath}` };
    }

    // Default target is the original location (parse from backup filename)
    const restorePath = targetPath
      ? path.join(docsRoot, targetPath)
      : inferOriginalPath(docsRoot, fullBackupPath);

    // Create a backup of current file if it exists
    if (fs.existsSync(restorePath)) {
      backupFileBeforeEdit(docsRoot, restorePath, 'Pre-restore backup');
    }

    // Restore the file
    fs.copyFileSync(fullBackupPath, restorePath);

    return { success: true, restoredPath: path.relative(docsRoot, restorePath) };
  } catch (error) {
    return { success: false, error: `Restore failed: ${error}` };
  }
}

/**
 * List all backups, optionally filtered by type or source file
 */
export function listBackups(
  docsRoot: string,
  filter?: { type?: BackupEntry['type']; sourceFile?: string }
): BackupEntry[] {
  const backupDir = path.join(docsRoot, DEFAULT_CONFIG.backupDir);
  const manifestPath = path.join(backupDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BackupEntry[];

    return manifest.filter((entry) => {
      if (filter?.type && entry.type !== filter.type) return false;
      if (filter?.sourceFile && !entry.sourcePath.includes(filter.sourceFile)) return false;
      return true;
    });
  } catch {
    return [];
  }
}

/**
 * Clean up old backups based on retention policy
 */
export function cleanupOldBackups(
  docsRoot: string,
  config: Partial<BackupConfig> = {}
): { removed: number; errors: string[] } {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const backupDir = path.join(docsRoot, cfg.backupDir);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - cfg.retentionDays);

  const removed: string[] = [];
  const errors: string[] = [];

  const entries = listBackups(docsRoot);

  for (const entry of entries) {
    const entryDate = new Date(entry.timestamp);
    if (entryDate < cutoffDate) {
      const fullPath = path.join(docsRoot, entry.backupPath);
      try {
        if (fs.existsSync(fullPath)) {
          if (fs.statSync(fullPath).isDirectory()) {
            fs.rmSync(fullPath, { recursive: true });
          } else {
            fs.unlinkSync(fullPath);
          }
          removed.push(entry.backupPath);
        }
      } catch (err) {
        errors.push(`Failed to remove ${entry.backupPath}: ${err}`);
      }
    }
  }

  // Update manifest to remove deleted entries
  if (removed.length > 0) {
    const updatedEntries = entries.filter((e) => !removed.includes(e.backupPath));
    const manifestPath = path.join(backupDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(updatedEntries, null, 2));
  }

  return { removed: removed.length, errors };
}

// ============================================================================
// Helper Functions
// ============================================================================

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function generateBackupId(): string {
  return `backup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function generateBackupFilename(
  originalFilename: string,
  timestamp: Date,
  type: BackupEntry['type']
): string {
  const ext = path.extname(originalFilename);
  const base = path.basename(originalFilename, ext);
  return `${base}.${type}.${formatTimestamp(timestamp)}${ext}`;
}

function appendToManifest(backupDir: string, entry: BackupEntry): void {
  const manifestPath = path.join(backupDir, 'manifest.json');
  let manifest: BackupEntry[] = [];

  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      manifest = [];
    }
  }

  manifest.push(entry);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function cleanupFileBackups(backupDir: string, filename: string, maxBackups: number): void {
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BackupEntry[];

    // Find all backups for this file (excluding snapshots)
    const fileBackups = manifest
      .filter((e) => e.type !== 'snapshot' && path.basename(e.sourcePath) === filename)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Remove excess backups
    if (fileBackups.length > maxBackups) {
      const toRemove = fileBackups.slice(maxBackups);
      for (const entry of toRemove) {
        const fullPath = path.join(backupDir, '..', entry.backupPath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }

      // Update manifest
      const removePaths = new Set(toRemove.map((e) => e.backupPath));
      const updated = manifest.filter((e) => !removePaths.has(e.backupPath));
      fs.writeFileSync(manifestPath, JSON.stringify(updated, null, 2));
    }
  } catch {
    // Ignore manifest errors during cleanup
  }
}

function cleanupSnapshots(backupDir: string, maxSnapshots: number): void {
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BackupEntry[];

    const snapshots = manifest
      .filter((e) => e.type === 'snapshot')
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (snapshots.length > maxSnapshots) {
      const toRemove = snapshots.slice(maxSnapshots);
      for (const entry of toRemove) {
        const fullPath = path.join(backupDir, '..', entry.backupPath);
        if (fs.existsSync(fullPath)) {
          fs.rmSync(fullPath, { recursive: true });
        }
      }

      const removePaths = new Set(toRemove.map((e) => e.backupPath));
      const updated = manifest.filter((e) => !removePaths.has(e.backupPath));
      fs.writeFileSync(manifestPath, JSON.stringify(updated, null, 2));
    }
  } catch {
    // Ignore manifest errors during cleanup
  }
}

function copyDocsRecursively(
  srcDir: string,
  destDir: string,
  excludeDir: string
): number {
  let count = 0;

  function walk(currentSrc: string, currentDest: string): void {
    const entries = fs.readdirSync(currentSrc, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(currentSrc, entry.name);
      const destPath = path.join(currentDest, entry.name);

      // Skip the backup directory and hidden directories
      if (entry.name === excludeDir || entry.name.startsWith('.')) {
        continue;
      }

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        walk(srcPath, destPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        fs.copyFileSync(srcPath, destPath);
        count++;
      }
    }
  }

  walk(srcDir, destDir);
  return count;
}

function inferOriginalPath(docsRoot: string, backupPath: string): string {
  // Parse backup filename to extract original name
  // Format: originalname.type.timestamp.ext
  const filename = path.basename(backupPath);
  const parts = filename.split('.');

  if (parts.length >= 4) {
    // Remove type and timestamp parts
    const ext = parts.pop();
    parts.pop(); // Remove timestamp
    parts.pop(); // Remove type
    const originalName = parts.join('.') + '.' + ext;
    return path.join(docsRoot, originalName);
  }

  // Fallback: just use the backup filename
  return path.join(docsRoot, filename);
}
