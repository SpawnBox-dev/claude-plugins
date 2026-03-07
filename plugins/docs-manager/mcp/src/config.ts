/**
 * Configuration System for docs-manager MCP Server
 *
 * ARCHITECTURE PHILOSOPHY (2026-01-07 Refactor):
 * This MCP provides INFORMATION, not JUDGMENTS.
 * - We extract structured data from files
 * - We provide schema definitions
 * - We perform deterministic operations
 * - The calling LLM makes semantic judgments (equivalence, quality, etc.)
 *
 * Supports:
 * - Auto-detection of project type from package.json, Cargo.toml, etc.
 * - Presets for common stacks (tauri-react, node-express, python-fastapi, etc.)
 * - User overrides via docs-manager.config.json
 * - Environment variable overrides
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export type LanguageId = 'rust' | 'typescript' | 'python' | 'go' | 'java' | 'csharp';

export interface ConceptualCheckConfig {
  name: string;
  description: string;
  required: boolean;
  patterns: string[]; // Stored as strings, converted to RegExp at runtime
  suggestions: string[];
}

export interface DocTypeConfig {
  name: string;
  verificationStrategy: 'source-facts' | 'conceptual' | 'hybrid';
  conceptualChecks: ConceptualCheckConfig[];
  // Optional: required sections for this doc type (overrides global defaults)
  requiredSections?: string[];
  // Optional: recommended sections for this doc type
  recommendedSections?: string[];
}

export interface SchemaConfig {
  // Required HTML comments in doc body (e.g., 'AI-CONTEXT', 'TRUST-LEVEL')
  requiredHtmlComments: string[];
  // Required sections for all docs
  requiredSections: string[];
  // Recommended (but not required) sections
  recommendedSections: string[];
  // Whether to require Quick Reference blockquote
  requireQuickReference: boolean;
  // Whether to require History section with dated entries
  requireHistoryFormat: boolean;
  // Whether to require Verification Notes format
  requireVerificationNotesFormat: boolean;
  // NOTE: Section equivalents removed in 2026-01-07 refactor.
  // The calling LLM now handles semantic equivalence (e.g., "Gotchas" vs "Best Practices").
}

export interface DocsManagerConfig {
  // Paths
  projectRoot: string;
  docsRoot: string;

  // Languages to enable for source fact extraction
  languages: LanguageId[];

  // Doc types and their configurations
  docTypes: Record<string, DocTypeConfig>;

  // Default doc type when not specified
  defaultDocType: string;

  // Schema validation settings
  schema: SchemaConfig;

  // Preset name (for reference)
  preset?: string;

  // Detection reasons (for logging)
  detectionReasons?: string[];
}

export interface ConfigFile {
  // Use a preset as base
  preset?: 'tauri-react' | 'node-express' | 'python-fastapi' | 'rust-cli' | 'minimal';

  // Override paths (relative to config file location)
  docsRoot?: string;

  // Override enabled languages
  languages?: LanguageId[];

  // Add custom doc types
  customDocTypes?: Record<string, DocTypeConfig>;

  // Override specific doc type settings
  docTypeOverrides?: Record<string, Partial<DocTypeConfig>>;

  // Add patterns to existing conceptual checks
  additionalPatterns?: Record<string, Record<string, string[]>>;
}

// ============================================================================
// Presets
// ============================================================================

const BASE_CONCEPTUAL_CHECKS: Record<string, ConceptualCheckConfig[]> = {
  architecture: [
    {
      name: 'Design Rationale',
      description: 'Explains WHY this architecture was chosen',
      required: true,
      patterns: [
        'why\\s+(we|this|the)\\s+(chose|use|implement)',
        'design\\s+decision',
        'rationale',
        'trade-?off',
        'alternative',
        'chosen\\s+because',
      ],
      suggestions: [
        'Add a "Design Decisions" section explaining why this approach was chosen',
        'Discuss alternatives that were considered and why they were rejected',
      ],
    },
    {
      name: 'System Relationships',
      description: 'Shows how this fits with other systems',
      required: true,
      patterns: [
        'integrat(es?|ion)\\s+with',
        'depends\\s+on',
        'communicates?\\s+with',
        '→|-->|->',
        'graph\\s+(TD|LR|TB|RL)',
      ],
      suggestions: [
        'Add a diagram showing how this system connects to others',
        'Describe which components depend on this system',
      ],
    },
    {
      name: 'Component Overview',
      description: 'Lists major components and their responsibilities',
      required: true,
      patterns: ['component', 'module', 'responsibility', 'purpose', 'role'],
      suggestions: ['List each major component with its responsibility'],
    },
    {
      name: 'Gotchas/Edge Cases',
      description: 'Documents non-obvious behaviors and pitfalls',
      required: false,
      patterns: ['gotcha', 'edge\\s+case', 'caveat', 'warning', 'pitfall', 'careful'],
      suggestions: ['Add a "Gotchas & Edge Cases" section'],
    },
  ],

  guide: [
    {
      name: 'Prerequisites',
      description: 'States what the reader needs before starting',
      required: true,
      patterns: ['prerequisite', 'before\\s+(you\\s+)?(start|begin)', 'require', 'need\\s+to\\s+have'],
      suggestions: ['Add a "Prerequisites" section listing what readers need'],
    },
    {
      name: 'Step-by-Step Instructions',
      description: 'Provides numbered, actionable steps',
      required: true,
      patterns: ['step\\s+\\d', '^\\d+\\.\\s+', 'first,?\\s+', 'then,?\\s+', 'finally,?\\s+'],
      suggestions: ['Break the guide into numbered steps'],
    },
    {
      name: 'Verification',
      description: 'Tells readers how to verify success',
      required: true,
      patterns: ['verify', 'confirm', 'check\\s+that', 'you\\s+should\\s+see', 'expected\\s+(output|result)'],
      suggestions: ['Add a verification step showing expected output'],
    },
    {
      name: 'Troubleshooting',
      description: 'Addresses common problems',
      required: false,
      patterns: ['troubleshoot', 'common\\s+(issue|problem|error)', 'if\\s+you\\s+(see|get|encounter)'],
      suggestions: ['Add a "Troubleshooting" section for common issues'],
    },
  ],

  api: [
    {
      name: 'Endpoint Documentation',
      description: 'Lists all endpoints/commands',
      required: true,
      patterns: ['endpoint', 'command', 'invoke', 'request', 'response'],
      suggestions: ['Document each API endpoint or command'],
    },
    {
      name: 'Error Handling',
      description: 'Documents error cases',
      required: true,
      patterns: ['error', 'exception', 'fail', 'throw'],
      suggestions: ['Add an error handling section'],
    },
  ],

  database: [
    {
      name: 'Schema Definition',
      description: 'Shows table structure',
      required: true,
      patterns: ['schema', 'table', 'column', 'CREATE TABLE', 'erDiagram'],
      suggestions: ['Add table definitions with column types'],
    },
    {
      name: 'Relationships',
      description: 'Documents foreign keys and joins',
      required: true,
      patterns: ['relationship', 'foreign\\s+key', 'join', 'reference'],
      suggestions: ['Document how tables relate to each other'],
    },
    {
      name: 'Query Examples',
      description: 'Shows common queries',
      required: true,
      patterns: ['```sql', 'SELECT', 'INSERT', 'UPDATE', 'query'],
      suggestions: ['Add SQL examples for common operations'],
    },
  ],

  meta: [
    {
      name: 'Purpose',
      description: 'Explains why this standard exists',
      required: true,
      patterns: ['purpose', 'goal', 'why', 'intent'],
      suggestions: ['Add a section explaining why this standard exists'],
    },
    {
      name: 'Rules/Guidelines',
      description: 'States the actual rules',
      required: true,
      patterns: ['rule', 'guideline', 'must', 'should', 'shall'],
      suggestions: ['List the specific rules or guidelines'],
    },
    {
      name: 'Examples',
      description: 'Shows good and bad examples',
      required: true,
      patterns: ['example', 'good.*bad', 'correct.*incorrect'],
      suggestions: ['Add examples of correct usage'],
    },
  ],
};

// Backend checks - generic (framework-agnostic patterns)
const BACKEND_CHECKS: ConceptualCheckConfig[] = [
  {
    name: 'Core Principles',
    description: 'States the design philosophy',
    required: false,
    // Generic: looks for design rationale language, not framework-specific terms
    patterns: ['principle', 'design\\s+(goal|philosophy|decision)', 'key\\s+insight', 'core\\s+(concept|idea)', 'rationale', 'why\\s+(we|this)'],
    suggestions: ['Add a "Core Principles" section with design tenets'],
  },
  {
    name: 'Architecture Diagram',
    description: 'Visual representation of the system',
    required: true,
    // Generic: mermaid syntax is standard, ASCII art arrows also work
    patterns: ['```mermaid', 'graph\\s+(TD|LR|TB|RL)', 'sequenceDiagram', 'flowchart', '\\[.*\\]\\s*-->', '─|│|├|└'],
    suggestions: ['Add a Mermaid diagram showing component relationships'],
  },
  {
    name: 'Usage Examples',
    description: 'Shows how to use the system',
    required: true,
    // Generic: any fenced code block counts, plus "example"/"usage" keywords
    patterns: ['example', 'usage', '```\\w+', 'how\\s+to\\s+(use|call|invoke)'],
    suggestions: ['Add code examples showing common usage patterns'],
  },
  {
    name: 'Gotchas/Edge Cases',
    description: 'Documents non-obvious behaviors',
    required: false,
    // Generic: common warning language across all domains
    patterns: ['gotcha', 'edge\\s+case', 'caveat', 'warning', 'pitfall', 'careful', 'note:', 'important:', 'caution'],
    suggestions: ['Add a "Gotchas & Edge Cases" section'],
  },
];

// Frontend checks - generic (works for React, Vue, Svelte, Angular, etc.)
const FRONTEND_GENERIC_CHECKS: ConceptualCheckConfig[] = [
  {
    name: 'Component Hierarchy',
    description: 'Shows component structure and file organization',
    required: true,
    // Generic: tree structures, file paths, hierarchy concepts
    patterns: ['component', 'hierarchy', '├──|└──', 'tree', 'file.*structure', 'structure', 'layout'],
    suggestions: ['Add a component tree showing parent/child relationships'],
  },
  {
    name: 'Store Integration',
    description: 'Documents how component connects to state management',
    required: true,
    // Generic: state management concepts, not specific libraries
    patterns: ['store', 'state', 'selector', 'subscribe', 'dispatch', 'action', 'reducer', 'mutation', 'getter'],
    suggestions: ['Document which store(s) this feature uses'],
  },
  {
    name: 'Props & Types',
    description: 'Documents component interfaces and types',
    required: true,
    // Generic: interface/type concepts, prop tables
    patterns: ['props?', 'interface', 'type\\s+\\w+', '\\|\\s*prop\\s*\\|', '\\|\\s*name\\s*\\|.*\\|\\s*type\\s*\\|', 'parameter', 'argument'],
    suggestions: ['Add a props table with types and descriptions'],
  },
  {
    name: 'Event Handling',
    description: 'Documents user interactions and event subscriptions',
    required: false,
    // Generic: event concepts, not framework-specific handlers
    patterns: ['event', 'handler', 'listener', 'callback', 'trigger', 'emit', 'subscribe', 'on[A-Z]\\w+'],
    suggestions: ['Document key event handlers and what they do'],
  },
  {
    name: 'Styling Approach',
    description: 'Documents CSS/styling patterns used',
    required: false,
    // Generic: CSS concepts, not specific libraries
    patterns: ['css', 'style', 'class', 'theme', 'responsive', 'layout', 'design\\s+system'],
    suggestions: ['Document key styling patterns or custom classes used'],
  },
  {
    name: 'Usage Examples',
    description: 'Shows how to use components',
    required: true,
    // Generic: any code block or component syntax
    patterns: ['```\\w+', '<\\w+[\\s/>]', 'example', 'usage', 'import\\s+'],
    suggestions: ['Add code examples showing component usage'],
  },
  {
    name: 'Gotchas & Edge Cases',
    description: 'Documents non-obvious behaviors and pitfalls',
    required: false,
    // Generic: warning language
    patterns: ['gotcha', 'edge\\s+case', 'caveat', 'warning', 'important', 'careful', 'pitfall', 'note:', 'caution'],
    suggestions: ['Document any race conditions or timing issues'],
  },
];

// Note: FRONTEND_VUE_CHECKS removed - FRONTEND_GENERIC_CHECKS now covers all frameworks
// The generic patterns work for Vue, React, Svelte, Angular, etc.

// ============================================================================
// Default Schema Configuration
// ============================================================================

// NOTE: DEFAULT_SECTION_EQUIVALENTS removed in 2026-01-07 refactor.
// The calling LLM now handles semantic equivalence.
//
// Previously this contained 50+ alternative section names like:
// - "Gotchas & Edge Cases" -> ["Gotchas", "Best Practices", "Common Issues", ...]
// - "Overview" -> ["Introduction", "Summary", "About", ...]
//
// This was fragile because every new doc style required new mappings.
// Now we extract sections exactly as written and let the LLM judge equivalence.

/**
 * Default schema settings - can be overridden per project
 * These are reasonable defaults but NOT mandatory for all projects
 */
const DEFAULT_SCHEMA_CONFIG: SchemaConfig = {
  // HTML comments - useful for AI context but optional
  requiredHtmlComments: [], // Empty by default - let projects opt-in
  // Core sections that help any doc
  requiredSections: ['Overview'],
  // Nice-to-have sections
  recommendedSections: ['Usage Examples', 'Related Documentation'],
  // These are opinionated - disabled by default
  requireQuickReference: false,
  requireHistoryFormat: false,
  requireVerificationNotesFormat: false,
};

/**
 * Strict schema for projects that want full AI-optimized docs
 * Enable by setting schema: STRICT_SCHEMA_CONFIG in your preset
 *
 * Note: 'Quick Reference' is NOT in requiredSections because requireQuickReference=true
 * handles it (checks for the blockquote format: > **Quick Reference**: ...)
 * This avoids requiring BOTH a blockquote AND a ## section header.
 */
const STRICT_SCHEMA_CONFIG: SchemaConfig = {
  requiredHtmlComments: ['AI-CONTEXT', 'TRUST-LEVEL', 'SCOPE'],
  requiredSections: ['Overview', 'History', 'Verification Notes'],
  recommendedSections: ['Architecture', 'API Reference', 'Usage Examples', 'Gotchas & Edge Cases', 'Related Documentation'],
  requireQuickReference: true,
  requireHistoryFormat: true,
  requireVerificationNotesFormat: true,
};

// Presets
const PRESETS: Record<string, Partial<DocsManagerConfig>> = {
  'tauri-react': {
    languages: ['rust', 'typescript'],
    docTypes: {
      architecture: {
        name: 'Architecture',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.architecture,
      },
      backend: {
        name: 'Backend',
        verificationStrategy: 'hybrid',
        conceptualChecks: BACKEND_CHECKS,
      },
      frontend: {
        name: 'Frontend',
        verificationStrategy: 'hybrid',
        conceptualChecks: FRONTEND_GENERIC_CHECKS,
      },
      api: {
        name: 'API',
        verificationStrategy: 'source-facts',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.api,
      },
      database: {
        name: 'Database',
        verificationStrategy: 'source-facts',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.database,
      },
      guide: {
        name: 'Guide',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.guide,
      },
      meta: {
        name: 'Meta',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.meta,
      },
      datapack: {
        name: 'Datapack',
        verificationStrategy: 'hybrid',
        conceptualChecks: [
          {
            name: 'Function Structure',
            description: 'Explains function organization',
            required: true,
            patterns: ['function', 'mcfunction', 'namespace', 'data\\s+pack'],
            suggestions: ['List the main functions and their purposes'],
          },
          {
            name: 'Scoreboards',
            description: 'Documents scoreboard usage',
            required: true,
            patterns: ['scoreboard', 'objective', 'score'],
            suggestions: ['List scoreboard objectives and what they track'],
          },
        ],
      },
    },
    defaultDocType: 'backend',
    // This project uses strict AI-optimized docs
    schema: STRICT_SCHEMA_CONFIG,
  },

  'node-express': {
    languages: ['typescript'],
    docTypes: {
      architecture: {
        name: 'Architecture',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.architecture,
      },
      backend: {
        name: 'Backend',
        verificationStrategy: 'hybrid',
        conceptualChecks: BACKEND_CHECKS,
      },
      api: {
        name: 'API',
        verificationStrategy: 'source-facts',
        conceptualChecks: [
          ...BASE_CONCEPTUAL_CHECKS.api,
          {
            name: 'Route Documentation',
            description: 'Documents Express routes',
            required: true,
            patterns: ['router', 'app\\.(get|post|put|delete)', 'middleware'],
            suggestions: ['Document each route handler'],
          },
        ],
      },
      database: {
        name: 'Database',
        verificationStrategy: 'source-facts',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.database,
      },
      guide: {
        name: 'Guide',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.guide,
      },
      meta: {
        name: 'Meta',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.meta,
      },
    },
    defaultDocType: 'backend',
    schema: DEFAULT_SCHEMA_CONFIG,
  },

  'vue-pinia': {
    languages: ['typescript'],
    docTypes: {
      architecture: {
        name: 'Architecture',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.architecture,
      },
      frontend: {
        name: 'Frontend',
        verificationStrategy: 'hybrid',
        conceptualChecks: FRONTEND_GENERIC_CHECKS,
      },
      api: {
        name: 'API',
        verificationStrategy: 'source-facts',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.api,
      },
      guide: {
        name: 'Guide',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.guide,
      },
      meta: {
        name: 'Meta',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.meta,
      },
    },
    defaultDocType: 'frontend',
    schema: DEFAULT_SCHEMA_CONFIG,
  },

  'rust-cli': {
    languages: ['rust'],
    docTypes: {
      architecture: {
        name: 'Architecture',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.architecture,
      },
      backend: {
        name: 'Backend',
        verificationStrategy: 'hybrid',
        conceptualChecks: BACKEND_CHECKS,
      },
      api: {
        name: 'API',
        verificationStrategy: 'source-facts',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.api,
      },
      guide: {
        name: 'Guide',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.guide,
      },
      meta: {
        name: 'Meta',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.meta,
      },
    },
    defaultDocType: 'backend',
    schema: DEFAULT_SCHEMA_CONFIG,
  },

  minimal: {
    languages: [],
    docTypes: {
      architecture: {
        name: 'Architecture',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.architecture,
      },
      guide: {
        name: 'Guide',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.guide,
      },
      meta: {
        name: 'Meta',
        verificationStrategy: 'conceptual',
        conceptualChecks: BASE_CONCEPTUAL_CHECKS.meta,
      },
    },
    defaultDocType: 'guide',
    schema: DEFAULT_SCHEMA_CONFIG,
  },
};

// ============================================================================
// Auto-Detection
// ============================================================================

interface DetectionResult {
  preset: string;
  confidence: number;
  reasons: string[];
}

function detectProjectType(projectRoot: string): DetectionResult {
  const results: DetectionResult[] = [];

  // Check for Cargo.toml (Rust) - also check src-tauri for Tauri projects
  const cargoPaths = [
    path.join(projectRoot, 'Cargo.toml'),
    path.join(projectRoot, 'src-tauri', 'Cargo.toml'),
  ];

  let cargoContent: string | null = null;
  let foundCargoPath: string | null = null;

  for (const cargoPath of cargoPaths) {
    if (fs.existsSync(cargoPath)) {
      cargoContent = fs.readFileSync(cargoPath, 'utf-8');
      foundCargoPath = cargoPath;
      break;
    }
  }

  if (cargoContent && foundCargoPath) {
    // Check for Tauri
    if (cargoContent.includes('tauri')) {
      // Check for React/TypeScript frontend
      const packageJsonPath = path.join(projectRoot, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        if (pkg.dependencies?.react || pkg.devDependencies?.react) {
          results.push({
            preset: 'tauri-react',
            confidence: 0.95,
            reasons: ['Cargo.toml with tauri dependency', 'package.json with React'],
          });
        }
      }
    } else {
      results.push({
        preset: 'rust-cli',
        confidence: 0.7,
        reasons: ['Cargo.toml found (non-Tauri Rust project)'],
      });
    }
  }

  // Check for package.json (Node/Frontend)
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Vue + Pinia
      if (deps.vue && deps.pinia) {
        results.push({
          preset: 'vue-pinia',
          confidence: 0.9,
          reasons: ['package.json with Vue and Pinia'],
        });
      }

      // Express
      if (deps.express) {
        results.push({
          preset: 'node-express',
          confidence: 0.85,
          reasons: ['package.json with Express'],
        });
      }
    } catch {
      // Invalid JSON, skip
    }
  }

  // Sort by confidence and return best match
  results.sort((a, b) => b.confidence - a.confidence);

  if (results.length > 0) {
    return results[0];
  }

  return {
    preset: 'minimal',
    confidence: 0.5,
    reasons: ['No specific framework detected, using minimal preset'],
  };
}

// ============================================================================
// Configuration Loading
// ============================================================================

let cachedConfig: DocsManagerConfig | null = null;
let configLoadedFrom: string | null = null;

export function loadConfig(projectRoot?: string): DocsManagerConfig {
  // Use cached if available and project root matches
  if (cachedConfig && configLoadedFrom === projectRoot) {
    return cachedConfig;
  }

  // Determine project root
  const root = projectRoot || process.env.DOCS_MANAGER_PROJECT_ROOT || process.cwd();

  // Look for config file
  const configPaths = [
    path.join(root, 'docs-manager.config.json'),
    path.join(root, '.docs-manager.json'),
    path.join(root, 'docs', 'docs-manager.config.json'),
  ];

  let configFile: ConfigFile | null = null;
  let configFilePath: string | null = null;

  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      try {
        configFile = JSON.parse(fs.readFileSync(p, 'utf-8'));
        configFilePath = p;
        break;
      } catch (e) {
        console.warn(`Failed to parse config file ${p}:`, e);
      }
    }
  }

  // Determine preset
  let presetName: string;
  let detectionReasons: string[] = [];
  if (configFile?.preset) {
    presetName = configFile.preset;
  } else {
    const detection = detectProjectType(root);
    presetName = detection.preset;
    detectionReasons = detection.reasons;
  }

  const preset = PRESETS[presetName] || PRESETS.minimal;

  // Build config
  const config: DocsManagerConfig = {
    projectRoot: root,
    docsRoot: configFile?.docsRoot
      ? path.resolve(configFilePath ? path.dirname(configFilePath) : root, configFile.docsRoot)
      : path.join(root, 'docs'),
    languages: configFile?.languages || preset.languages || [],
    docTypes: { ...preset.docTypes } as Record<string, DocTypeConfig>,
    defaultDocType: preset.defaultDocType || 'guide',
    schema: preset.schema || DEFAULT_SCHEMA_CONFIG,
    preset: presetName,
    detectionReasons,
  };

  // Apply custom doc types
  if (configFile?.customDocTypes) {
    for (const [key, value] of Object.entries(configFile.customDocTypes)) {
      config.docTypes[key] = value;
    }
  }

  // Apply doc type overrides
  if (configFile?.docTypeOverrides) {
    for (const [key, overrides] of Object.entries(configFile.docTypeOverrides)) {
      if (config.docTypes[key]) {
        config.docTypes[key] = { ...config.docTypes[key], ...overrides };
      }
    }
  }

  // Apply additional patterns
  if (configFile?.additionalPatterns) {
    for (const [docType, checks] of Object.entries(configFile.additionalPatterns)) {
      if (config.docTypes[docType]) {
        for (const [checkName, patterns] of Object.entries(checks)) {
          const check = config.docTypes[docType].conceptualChecks.find((c) => c.name === checkName);
          if (check) {
            check.patterns.push(...patterns);
          }
        }
      }
    }
  }

  // Cache and return
  cachedConfig = config;
  configLoadedFrom = root;

  return config;
}

export function clearConfigCache(): void {
  cachedConfig = null;
  configLoadedFrom = null;
}

// ============================================================================
// Helper Functions
// ============================================================================

export function getDocTypeConfig(docType: string): DocTypeConfig | undefined {
  const config = loadConfig();
  return config.docTypes[docType];
}

export function getAllDocTypes(): string[] {
  const config = loadConfig();
  return Object.keys(config.docTypes);
}

export function getEnabledLanguages(): LanguageId[] {
  const config = loadConfig();
  return config.languages;
}

export function isLanguageEnabled(lang: LanguageId): boolean {
  return getEnabledLanguages().includes(lang);
}

export function getProjectRoot(): string {
  return loadConfig().projectRoot;
}

export function getDocsRoot(): string {
  return loadConfig().docsRoot;
}

/**
 * Get schema configuration for validation
 */
export function getSchemaConfig(): SchemaConfig {
  return loadConfig().schema;
}

/**
 * Convert stored pattern strings to RegExp objects
 */
export function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, 'i'));
}

/**
 * Get verification strategy for a doc type
 */
export function getVerificationStrategy(docType: string): 'source-facts' | 'conceptual' | 'hybrid' {
  const config = getDocTypeConfig(docType);
  return config?.verificationStrategy || 'hybrid';
}

// NOTE: getSectionEquivalents() and hasSectionOrEquivalent() removed in 2026-01-07 refactor.
// The calling LLM now handles semantic equivalence by comparing extracted sections to schema.
//
// Instead, use extractSections() to get exact section headers, then let the LLM decide
// if "## Best Practices" is equivalent to "## Gotchas & Edge Cases" for a given context.

/**
 * Extract all section headers from document content
 * Returns the exact header text as written (no normalization)
 * @param content Document content to parse
 * @returns Array of section headers (e.g., ["## Overview", "## 1. Architecture", "## Best Practices"])
 */
export function extractSections(content: string): string[] {
  const sectionRegex = /^(#{1,6})\s+(.+)$/gm;
  const sections: string[] = [];
  let match;

  while ((match = sectionRegex.exec(content)) !== null) {
    sections.push(`${match[1]} ${match[2]}`);
  }

  return sections;
}

/**
 * Check if a document has a specific section (exact match only)
 * For semantic equivalence, the calling LLM should compare against extracted sections
 * @param content Document content
 * @param sectionHeader Exact section header to find (e.g., "## Overview")
 */
export function hasExactSection(content: string, sectionHeader: string): boolean {
  const sections = extractSections(content);
  return sections.some(s => s.toLowerCase() === sectionHeader.toLowerCase());
}

/**
 * Standard doc types that can be inferred from folder location
 * Maps folder name patterns to doc type identifiers
 * Can be extended via config if needed
 */
const FOLDER_TO_DOC_TYPE: Array<{ pattern: RegExp; docType: string }> = [
  { pattern: /^architecture\//i, docType: 'architecture' },
  { pattern: /[/\\]architecture\//i, docType: 'architecture' },
  { pattern: /^guides?\//i, docType: 'guide' },
  { pattern: /[/\\]guides?\//i, docType: 'guide' },
  { pattern: /^api\//i, docType: 'api' },
  { pattern: /[/\\]api\//i, docType: 'api' },
  { pattern: /^database\//i, docType: 'database' },
  { pattern: /[/\\]database\//i, docType: 'database' },
  { pattern: /^frontend\//i, docType: 'frontend' },
  { pattern: /[/\\]frontend\//i, docType: 'frontend' },
  { pattern: /^datapack\//i, docType: 'datapack' },
  { pattern: /[/\\]datapack\//i, docType: 'datapack' },
  { pattern: /^meta\//i, docType: 'meta' },
  { pattern: /[/\\]meta\//i, docType: 'meta' },
  { pattern: /^backend\//i, docType: 'backend' },
  { pattern: /[/\\]backend\//i, docType: 'backend' },
];

/**
 * Get doc type signals from a document path
 * Returns all signals rather than making a decision - LLM can weigh these
 * @param docPath Path to the document (relative to docs root)
 * @returns Object with folder-based type (if any) and other signals
 */
export function getDocTypeSignals(docPath: string): {
  folderType: string | null;
  folder: string;
} {
  let folderType: string | null = null;

  for (const { pattern, docType } of FOLDER_TO_DOC_TYPE) {
    if (pattern.test(docPath)) {
      folderType = docType;
      break;
    }
  }

  // Extract folder name for LLM context
  const pathParts = docPath.split(/[/\\]/);
  const folder = pathParts.length > 1 ? pathParts[0] : '';

  return { folderType, folder };
}

// DEPRECATED: Use getDocTypeSignals() instead. Left for backward compatibility.
export function inferDocTypeFromPath(docPath: string): string | null {
  return getDocTypeSignals(docPath).folderType;
}

/**
 * Check if any frontmatter tags match valid doc types
 * Returns matches rather than making a decision - LLM can weigh these
 * @param tags Array of tags from frontmatter
 * @returns Array of matching doc types (may be empty or have multiple)
 */
export function getDocTypeTagMatches(tags: string[] | undefined): string[] {
  if (!tags || !Array.isArray(tags)) return [];

  const config = loadConfig();
  const validDocTypes = Object.keys(config.docTypes);

  return tags.filter(tag => validDocTypes.includes(tag));
}

// DEPRECATED: Use getDocTypeTagMatches() instead. Left for backward compatibility.
export function inferDocTypeFromTags(tags: string[] | undefined): string | null {
  const matches = getDocTypeTagMatches(tags);
  return matches.length > 0 ? matches[0] : null;
}

// NOTE: isGuideDocument() removed in 2026-01-07 refactor.
// The calling LLM now makes this judgment based on:
// - Title (e.g., "How to...", "Setup Guide")
// - Sections (e.g., "## Prerequisites", "## Steps")
// - Content structure (numbered steps, etc.)
//
// Instead, we provide extractDocumentStructure() in schema.ts which gives
// the LLM all the raw information to make this determination.

// DEPRECATED: Kept for backward compatibility, but prefer LLM-based judgment
export function isGuideDocument(title: string, content?: string): boolean {
  // Simple heuristic - LLM should make the real decision
  const hasGuideTitle = /guide|how\s+to|tutorial|setup/i.test(title);
  const hasPrerequisites = content ? /## Prerequisites/i.test(content) : false;
  return hasGuideTitle || hasPrerequisites;
}

// ============================================================================
// Document Structure Extraction (New in 2026-01-07 Refactor)
// ============================================================================

/**
 * Complete structural information about a document
 * This is the primary output for LLM-based validation
 */
export interface DocumentStructure {
  // Path information
  filePath: string;
  folder: string;
  folderDocType: string | null;

  // Frontmatter (raw, no judgment)
  frontmatter: Record<string, unknown> | null;
  frontmatterTagDocTypes: string[]; // Tags that match valid doc types

  // Body structure (raw, no judgment)
  sections: string[];           // All section headers exactly as written
  htmlComments: string[];       // HTML comment labels (e.g., "AI-CONTEXT", "TRUST-LEVEL")
  hasQuickReference: boolean;   // Has "> **Quick Reference**" blockquote
  hasCodeBlocks: boolean;       // Has fenced code blocks
  hasMermaidDiagram: boolean;   // Has ```mermaid blocks
  todoCount: number;            // Number of TODO placeholders

  // Content signals (for LLM inference, not judgment)
  hasNumberedSteps: boolean;    // Has "1. " style numbered items
  hasPrerequisitesSection: boolean;
  hasHistorySection: boolean;
  hasVerificationSection: boolean;
}

/**
 * Extract complete structural information from a document
 * Returns raw facts - LLM makes judgments about what they mean
 *
 * @param content Document content (markdown)
 * @param filePath Path to the document (for folder inference)
 * @returns Structured extraction of all document elements
 */
export function extractDocumentStructure(
  content: string,
  filePath: string
): DocumentStructure {
  // Parse frontmatter
  let frontmatter: Record<string, unknown> | null = null;
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    try {
      // Dynamic import would be better, but for simplicity:
      const yaml = require('yaml');
      frontmatter = yaml.parse(fmMatch[1]) as Record<string, unknown>;
    } catch {
      frontmatter = null;
    }
  }

  // Get path signals
  const pathSignals = getDocTypeSignals(filePath);

  // Get tag matches
  const frontmatterTagDocTypes = frontmatter
    ? getDocTypeTagMatches(frontmatter.tags as string[] | undefined)
    : [];

  // Extract sections
  const sections = extractSections(content);

  // Extract HTML comments
  const htmlCommentRegex = /<!--\s*([A-Z][A-Z0-9_-]+)\s*:/g;
  const htmlComments: string[] = [];
  let commentMatch;
  while ((commentMatch = htmlCommentRegex.exec(content)) !== null) {
    htmlComments.push(commentMatch[1]);
  }

  // Check for specific structural elements
  const hasQuickReference = content.includes('> **Quick Reference**');
  const hasCodeBlocks = /```\w+/.test(content);
  const hasMermaidDiagram = content.includes('```mermaid');
  const todoCount = (content.match(/TODO/g) || []).length;
  const hasNumberedSteps = /^\d+\.\s+/m.test(content);

  // Check for specific sections (exact match, not semantic)
  const sectionsLower = sections.map(s => s.toLowerCase());
  const hasPrerequisitesSection = sectionsLower.some(s => s.includes('prerequisite'));
  const hasHistorySection = sectionsLower.some(s =>
    s.match(/^## history(?!:)/i) !== null || s === '## history'
  );
  const hasVerificationSection = sectionsLower.some(s => s.includes('verification'));

  return {
    filePath,
    folder: pathSignals.folder,
    folderDocType: pathSignals.folderType,
    frontmatter,
    frontmatterTagDocTypes,
    sections,
    htmlComments,
    hasQuickReference,
    hasCodeBlocks,
    hasMermaidDiagram,
    todoCount,
    hasNumberedSteps,
    hasPrerequisitesSection,
    hasHistorySection,
    hasVerificationSection,
  };
}
