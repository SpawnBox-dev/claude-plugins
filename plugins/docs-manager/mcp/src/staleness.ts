/**
 * Staleness Calculator
 *
 * Implements the trust/staleness calculation algorithm as defined in
 * docs/meta/2026-01-06-trust-calculation.md
 *
 * Calculates:
 * - Trust badges (FRESH, STALE, UNVERIFIED, AGING)
 * - Staleness scores
 * - Source file modification tracking
 */

import { simpleGit, SimpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export type TrustBadge = 'FRESH' | 'STALE' | 'UNVERIFIED' | 'AGING';

export interface StalenessResult {
  badge: TrustBadge;
  badgeEmoji: string;
  daysSinceVerification: number | null;
  daysSinceSourceChange: number | null;
  staleSources: StaleSource[];
  summary: string;
  /**
   * INFORMATIONAL priority based on days since verification.
   * The calling LLM should consider context:
   * - Critical API docs may need urgent attention even at LOW
   * - Stable architecture docs may be fine even at HIGH
   * - Doc type and importance matter more than this heuristic
   */
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
}

export interface StaleSource {
  path: string;
  lastModified: Date;
  daysSinceDocVerification: number;
}

// ============================================================================
// Constants
// ============================================================================

const BADGE_EMOJI: Record<TrustBadge, string> = {
  FRESH: '✅',
  STALE: '⚠️',
  UNVERIFIED: '❌',
  AGING: '🕐',
};

const AGING_THRESHOLD_DAYS = 30;

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Calculate staleness for a document given its frontmatter and sources
 *
 * Badge criteria:
 * - UNVERIFIED: no last-verified date OR verification-method is 'unverified'
 * - STALE: source files changed after last-verified date
 * - AGING: last-verified > 30 days ago (no source changes)
 * - FRESH: recently verified, no source changes
 */
export async function calculateStaleness(
  docsRoot: string,
  lastVerified: string | null,
  sources: string[],
  projectRoot: string,
  verificationMethod?: string
): Promise<StalenessResult> {
  // No verification date = UNVERIFIED
  if (!lastVerified) {
    return {
      badge: 'UNVERIFIED',
      badgeEmoji: BADGE_EMOJI.UNVERIFIED,
      daysSinceVerification: null,
      daysSinceSourceChange: null,
      staleSources: [],
      summary: 'Document has never been verified against code',
      priority: 'HIGH',
    };
  }

  // verification-method: unverified = treat as UNVERIFIED even with a date
  if (verificationMethod === 'unverified') {
    return {
      badge: 'UNVERIFIED',
      badgeEmoji: BADGE_EMOJI.UNVERIFIED,
      daysSinceVerification: null,
      daysSinceSourceChange: null,
      staleSources: [],
      summary: 'Document marked as unverified (verification-method: unverified)',
      priority: 'HIGH',
    };
  }

  const verificationDate = new Date(lastVerified);
  const today = new Date();
  const daysSinceVerification = Math.floor((today.getTime() - verificationDate.getTime()) / (1000 * 60 * 60 * 24));

  // Get source modification times
  const git = simpleGit(projectRoot);
  const staleSources: StaleSource[] = [];
  let latestSourceChange: Date | null = null;

  for (const source of sources) {
    try {
      const sourcePath = path.join(projectRoot, source);
      const modTime = await getLastModifiedTime(git, sourcePath, projectRoot);

      if (modTime) {
        if (!latestSourceChange || modTime > latestSourceChange) {
          latestSourceChange = modTime;
        }

        // Check if source was modified after verification
        if (modTime > verificationDate) {
          staleSources.push({
            path: source,
            lastModified: modTime,
            daysSinceDocVerification: Math.floor((modTime.getTime() - verificationDate.getTime()) / (1000 * 60 * 60 * 24)),
          });
        }
      }
    } catch {
      // Source file might not exist or git might fail - continue
    }
  }

  const daysSinceSourceChange = latestSourceChange
    ? Math.floor((today.getTime() - latestSourceChange.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  // Determine badge based on staleness algorithm
  if (staleSources.length > 0) {
    // Source changed after verification = STALE
    const priority = getPriority(daysSinceVerification);
    return {
      badge: 'STALE',
      badgeEmoji: BADGE_EMOJI.STALE,
      daysSinceVerification,
      daysSinceSourceChange,
      staleSources,
      summary: `${staleSources.length} source file(s) modified since last verification`,
      priority,
    };
  }

  if (daysSinceVerification > AGING_THRESHOLD_DAYS) {
    // Old verification but no source changes = AGING
    return {
      badge: 'AGING',
      badgeEmoji: BADGE_EMOJI.AGING,
      daysSinceVerification,
      daysSinceSourceChange,
      staleSources: [],
      summary: `Verified ${daysSinceVerification} days ago (> ${AGING_THRESHOLD_DAYS} day threshold)`,
      priority: 'LOW',
    };
  }

  // Recently verified, no source changes = FRESH
  return {
    badge: 'FRESH',
    badgeEmoji: BADGE_EMOJI.FRESH,
    daysSinceVerification,
    daysSinceSourceChange,
    staleSources: [],
    summary: `Verified ${daysSinceVerification} day(s) ago, no source changes since`,
    priority: 'NONE',
  };
}

/**
 * Extended scan result that includes docs with parsing issues
 */
export interface ExtendedScanResult {
  results: Map<string, StalenessResult>;
  /** Docs that couldn't be parsed - need manual attention */
  unparseable: Array<{
    filePath: string;
    error: string;
  }>;
  /** Total files found in docs folder */
  totalFiles: number;
}

/**
 * Scan all docs in a directory and calculate staleness for each
 *
 * Philosophy: Find EVERYTHING. Never silently skip files.
 * - Docs with valid frontmatter get staleness calculated
 * - Docs with invalid/missing frontmatter are reported as unparseable
 * - Nothing is silently ignored (except .unmanaged/ folder)
 */
export async function scanAllDocs(
  docsRoot: string,
  projectRoot: string,
  parseDocFrontmatter: (filePath: string) => Promise<{
    lastVerified?: string;
    sources?: string[];
    verificationMethod?: string;
  } | null>
): Promise<ExtendedScanResult> {
  const results = new Map<string, StalenessResult>();
  const unparseable: ExtendedScanResult['unparseable'] = [];

  // Find all markdown files (excluding archive, backups, and .unmanaged)
  const files = await findMarkdownFiles(docsRoot);

  for (const file of files) {
    const relativePath = path.relative(docsRoot, file);

    try {
      const frontmatter = await parseDocFrontmatter(file);

      if (!frontmatter) {
        // Frontmatter parsing failed - report it, don't skip it
        unparseable.push({
          filePath: relativePath,
          error: 'No valid YAML frontmatter found (missing --- delimiters or invalid YAML)',
        });
        continue;
      }

      const result = await calculateStaleness(
        docsRoot,
        frontmatter.lastVerified || null,
        frontmatter.sources || [],
        projectRoot,
        frontmatter.verificationMethod
      );

      results.set(relativePath, result);
    } catch (err) {
      // Catch any other errors - still report them
      unparseable.push({
        filePath: relativePath,
        error: err instanceof Error ? err.message : 'Unknown parsing error',
      });
    }
  }

  return {
    results,
    unparseable,
    totalFiles: files.length,
  };
}

/**
 * Generate a staleness report in markdown format
 * Now includes unparseable docs section
 */
export function generateStalenessReport(
  scanResult: ExtendedScanResult | Map<string, StalenessResult>
): string {
  // Handle both old Map format and new ExtendedScanResult format
  const results = scanResult instanceof Map ? scanResult : scanResult.results;
  const unparseable = scanResult instanceof Map ? [] : scanResult.unparseable;
  const totalFiles = scanResult instanceof Map ? results.size : scanResult.totalFiles;

  const stale: Array<[string, StalenessResult]> = [];
  const aging: Array<[string, StalenessResult]> = [];
  const unverified: Array<[string, StalenessResult]> = [];
  const fresh: Array<[string, StalenessResult]> = [];

  for (const [docPath, result] of results) {
    switch (result.badge) {
      case 'STALE': stale.push([docPath, result]); break;
      case 'AGING': aging.push([docPath, result]); break;
      case 'UNVERIFIED': unverified.push([docPath, result]); break;
      case 'FRESH': fresh.push([docPath, result]); break;
    }
  }

  // Sort by priority/days
  stale.sort((a, b) => (b[1].daysSinceVerification || 0) - (a[1].daysSinceVerification || 0));
  aging.sort((a, b) => (b[1].daysSinceVerification || 0) - (a[1].daysSinceVerification || 0));

  const managedCount = fresh.length + stale.length + aging.length + unverified.length;

  let report = `# Documentation Staleness Report\n\n`;
  report += `**Generated:** ${new Date().toISOString().split('T')[0]}\n\n`;
  report += `## Summary\n\n`;
  report += `**Total files found:** ${totalFiles}\n`;
  report += `**Under management:** ${managedCount}\n`;
  if (unparseable.length > 0) {
    report += `**⚠️ Need attention:** ${unparseable.length} (missing/invalid frontmatter)\n`;
  }
  report += `\n`;
  report += `| Badge | Count |\n`;
  report += `|-------|-------|\n`;
  report += `| ${BADGE_EMOJI.FRESH} FRESH | ${fresh.length} |\n`;
  report += `| ${BADGE_EMOJI.STALE} STALE | ${stale.length} |\n`;
  report += `| ${BADGE_EMOJI.AGING} AGING | ${aging.length} |\n`;
  report += `| ${BADGE_EMOJI.UNVERIFIED} UNVERIFIED | ${unverified.length} |\n`;
  if (unparseable.length > 0) {
    report += `| 🔧 NEEDS FRONTMATTER | ${unparseable.length} |\n`;
  }
  report += `\n`;

  if (stale.length > 0) {
    report += `## ${BADGE_EMOJI.STALE} Stale Documents\n\n`;
    report += `These documents have source files that changed since the last verification.\n\n`;
    report += `| Doc | Last Verified | Stale Sources | Priority |\n`;
    report += `|-----|---------------|---------------|----------|\n`;
    for (const [docPath, result] of stale) {
      const sources = result.staleSources.map(s => `\`${s.path}\``).join(', ');
      report += `| ${docPath} | ${result.daysSinceVerification}d ago | ${sources} | ${result.priority} |\n`;
    }
    report += `\n`;
  }

  if (aging.length > 0) {
    report += `## ${BADGE_EMOJI.AGING} Aging Documents\n\n`;
    report += `These documents haven't been verified in over ${AGING_THRESHOLD_DAYS} days.\n\n`;
    report += `| Doc | Days Since Verification |\n`;
    report += `|-----|-------------------------|\n`;
    for (const [docPath, result] of aging) {
      report += `| ${docPath} | ${result.daysSinceVerification} days |\n`;
    }
    report += `\n`;
  }

  if (unverified.length > 0) {
    report += `## ${BADGE_EMOJI.UNVERIFIED} Unverified Documents\n\n`;
    report += `These documents have never been verified against code.\n\n`;
    for (const [docPath] of unverified) {
      report += `- ${docPath}\n`;
    }
    report += `\n`;
  }

  // NEW: Report docs that need frontmatter work - with actionable options
  if (unparseable.length > 0) {
    report += `## 🔧 Unmanaged Documents Found (${unparseable.length})\n\n`;
    report += `These files exist in the docs folder but couldn't be parsed. **What would you like to do?**\n\n`;
    report += `### Option 1: Bring Under Management\n`;
    report += `Add proper YAML frontmatter to enable staleness tracking, validation, and index integration.\n\n`;
    report += `### Option 2: Exclude From Management\n`;
    report += `Move to \`docs/unmanaged/\` folder - the MCP will ignore files there.\n\n`;
    report += `---\n\n`;
    report += `| File | Issue | Suggested Action |\n`;
    report += `|------|-------|------------------|\n`;
    for (const doc of unparseable) {
      // Suggest doc type based on folder location
      const suggestedType = inferDocType(doc.filePath);
      const action = `\`docs_generate_template\` type="${suggestedType}"`;
      report += `| ${doc.filePath} | ${doc.error} | ${action} |\n`;
    }
    report += `\n`;
    report += `**To add frontmatter:** Tell me which files you want managed and I'll generate appropriate templates.\n`;
    report += `**To exclude:** Tell me which files to move to \`docs/unmanaged/\` and I'll move them.\n\n`;
  }

  report += `## ${BADGE_EMOJI.FRESH} Fresh Documents\n\n`;
  report += `${fresh.length} document(s) are up to date.\n`;

  return report;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the last modification time of a file using git log
 */
async function getLastModifiedTime(git: SimpleGit, filePath: string, projectRoot: string): Promise<Date | null> {
  try {
    // Try git first (preferred - tracks meaningful changes)
    const relativePath = path.relative(projectRoot, filePath);
    const log = await git.log({
      file: relativePath,
      maxCount: 1,
      format: { date: '%ci' },
    });

    if (log.latest) {
      return new Date(log.latest.date);
    }
  } catch {
    // Git failed, fall back to filesystem
  }

  try {
    // Fallback to filesystem stat
    const stats = fs.statSync(filePath);
    return stats.mtime;
  } catch {
    return null;
  }
}

/**
 * Find all markdown files in a directory recursively
 *
 * Excludes:
 * - Hidden directories (starting with .)
 * - archive/ - archived docs (managed separately)
 * - .unmanaged/ - user's opt-out folder for docs they don't want managed
 * - index.md - it's a navigation file, not documentation
 */
async function findMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip: hidden dirs, archive, and .unmanaged (user opt-out folder)
        if (entry.name.startsWith('.') || entry.name === 'archive' || entry.name === 'unmanaged') {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Skip index.md - it's navigation, not documentation
        if (entry.name === 'index.md') continue;
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * Infer document type from file path for template suggestions.
 *
 * INFORMATIONAL: This is a best-guess based on folder structure.
 * The calling LLM should:
 * - Verify this inference makes sense for the actual content
 * - Override if the doc content doesn't match the folder location
 * - Consider that docs may be miscategorized in the folder structure
 *
 * Default 'backend' is arbitrary - LLM should confirm appropriate type.
 */
function inferDocType(filePath: string): string {
  const lowerPath = filePath.toLowerCase();

  if (lowerPath.includes('backend/') || lowerPath.includes('backend\\')) return 'backend';
  if (lowerPath.includes('frontend/') || lowerPath.includes('frontend\\')) return 'frontend';
  if (lowerPath.includes('api/') || lowerPath.includes('api\\')) return 'api';
  if (lowerPath.includes('database/') || lowerPath.includes('database\\')) return 'database';
  if (lowerPath.includes('datapack/') || lowerPath.includes('datapack\\')) return 'datapack';
  if (lowerPath.includes('guide/') || lowerPath.includes('guide\\') ||
      lowerPath.includes('guides/') || lowerPath.includes('guides\\')) return 'guide';
  if (lowerPath.includes('architecture/') || lowerPath.includes('architecture\\')) return 'architecture';
  if (lowerPath.includes('meta/') || lowerPath.includes('meta\\')) return 'meta';

  // Default fallback - LLM should verify this makes sense
  return 'backend';
}

/**
 * Determine priority based on staleness days.
 *
 * INFORMATIONAL: These thresholds are heuristics, not rules.
 * The calling LLM should use these as signals but make contextual decisions:
 * - 90+ days: Likely needs review, but stable systems may be fine
 * - 30-90 days: Worth checking, especially for frequently-changing code
 * - 7-30 days: Low urgency for most docs
 * - <7 days: Recently verified
 *
 * The LLM should also consider:
 * - How actively the source files are being developed
 * - Whether the doc covers core vs. peripheral functionality
 * - The doc type (API docs need more accuracy than architecture docs)
 */
function getPriority(daysSinceVerification: number): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
  if (daysSinceVerification > 90) return 'CRITICAL';
  if (daysSinceVerification > 30) return 'HIGH';
  if (daysSinceVerification > 7) return 'MEDIUM';
  return 'LOW';
}
