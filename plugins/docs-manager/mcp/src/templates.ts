/**
 * Template Generator
 *
 * Generates documentation templates that match the project's AI-optimized
 * documentation standard. Templates include all required frontmatter fields,
 * HTML comments, and body sections.
 *
 * ENHANCED: Now includes doc-type specific templates, exemplary filled examples,
 * and section suggestions based on document type.
 */

// ============================================================================
// Types
// ============================================================================

export type DocType = 'backend' | 'frontend' | 'api' | 'database' | 'datapack' | 'guide' | 'architecture' | 'meta';

export interface TemplateConfig {
  title: string;
  docId: string;
  sources: string[];
  type: DocType;
  aliases?: string[];
  relatedDocs?: string[];
  component?: string;
  modules?: string[];
  // NEW: Additional fields for richer templates
  dependsOn?: Array<{ docId: string }>;
  prerequisites?: string[];
  aiSummary?: string;
  keywords?: string[];
}

// Section recommendations by doc type
export interface SectionRecommendation {
  name: string;
  /**
   * INFORMATIONAL: "common" means usually included, "optional" means situational.
   * The calling LLM should decide based on actual content needs.
   * A small, focused doc might skip "common" sections; a complex one might need "optional" ones.
   */
  importance: 'common' | 'optional';
  description: string;
  example?: string;
}

// ============================================================================
// Section Recommendations by Doc Type
// ============================================================================

/**
 * Section recommendations by document type.
 *
 * INFORMATIONAL: These are typical sections seen in good documentation.
 * The calling LLM should:
 * - Use these as a starting point, not a checklist
 * - Skip sections that don't apply to the specific doc
 * - Add sections not listed here if the content warrants it
 * - Consider the doc's scope when deciding which sections to include
 *
 * "common" = usually helpful for this doc type
 * "optional" = include if relevant to the specific content
 */
const SECTION_RECOMMENDATIONS: Record<DocType, SectionRecommendation[]> = {
  backend: [
    { name: 'Core Principles', importance: 'optional', description: 'Numbered list of design tenets guiding this system' },
    { name: 'System Components & Data Structures', importance: 'optional', description: 'Document structs, enums, and key types' },
    { name: 'Developer Guide', importance: 'optional', description: 'Step-by-step guide for extending/modifying this system' },
    { name: 'API Reference', importance: 'common', description: 'Public function signatures with exact types' },
    { name: 'Architecture', importance: 'common', description: 'Mermaid diagram showing component relationships' },
    { name: 'Usage Examples', importance: 'common', description: 'Working code snippets' },
    { name: 'Gotchas & Edge Cases', importance: 'optional', description: 'Non-obvious behaviors and workarounds' },
  ],
  frontend: [
    { name: 'Component Hierarchy', importance: 'common', description: 'Tree structure of UI components' },
    { name: 'Props & State', importance: 'common', description: 'Document component interfaces' },
    { name: 'Store Integration', importance: 'optional', description: 'How component connects to state management' },
    { name: 'Styling Notes', importance: 'optional', description: 'CSS/styling patterns used' },
    { name: 'Usage Examples', importance: 'common', description: 'Code examples showing component usage' },
  ],
  api: [
    { name: 'Endpoints', importance: 'common', description: 'Full endpoint documentation with request/response' },
    { name: 'Authentication', importance: 'optional', description: 'Auth requirements for endpoints' },
    { name: 'Request/Response Examples', importance: 'common', description: 'JSON examples for each endpoint' },
    { name: 'Error Codes', importance: 'common', description: 'Possible error responses and meanings' },
    { name: 'Rate Limiting', importance: 'optional', description: 'Rate limit details if applicable' },
  ],
  database: [
    { name: 'Schema', importance: 'common', description: 'Table definitions with column types' },
    { name: 'Relationships', importance: 'common', description: 'Foreign keys and join patterns' },
    { name: 'Indexes', importance: 'common', description: 'Index definitions and query optimization' },
    { name: 'Migrations', importance: 'optional', description: 'Migration history and patterns' },
    { name: 'Query Examples', importance: 'common', description: 'Common query patterns' },
  ],
  datapack: [
    { name: 'Function Tags', importance: 'common', description: 'Minecraft function tag registrations' },
    { name: 'Scoreboards', importance: 'common', description: 'Scoreboard objectives and usage' },
    { name: 'Data Flow', importance: 'common', description: 'How data moves through functions' },
    { name: 'Installation', importance: 'common', description: 'How to install/deploy the datapack' },
  ],
  guide: [
    { name: 'Prerequisites', importance: 'common', description: 'What the reader needs before starting' },
    { name: 'Steps', importance: 'common', description: 'Numbered step-by-step instructions' },
    { name: 'Troubleshooting', importance: 'optional', description: 'Common issues and solutions' },
    { name: 'Next Steps', importance: 'optional', description: 'What to do after completing the guide' },
  ],
  architecture: [
    { name: 'System Context', importance: 'common', description: 'Where this fits in the larger system' },
    { name: 'Components', importance: 'common', description: 'Major components and their responsibilities' },
    { name: 'Data Flow', importance: 'common', description: 'How data moves through the system' },
    { name: 'Design Decisions', importance: 'optional', description: 'Key architectural decisions and rationale' },
    { name: 'Trade-offs', importance: 'optional', description: 'Known limitations and alternatives considered' },
  ],
  meta: [
    { name: 'Purpose', importance: 'common', description: 'Why this meta-doc exists' },
    { name: 'Scope', importance: 'common', description: 'What this standard/protocol covers' },
    { name: 'Rules', importance: 'common', description: 'The actual rules/guidelines' },
    { name: 'Examples', importance: 'common', description: 'Good and bad examples' },
  ],
};

// ============================================================================
// Get Section Recommendations
// ============================================================================

export function getSectionRecommendations(type: DocType): SectionRecommendation[] {
  return SECTION_RECOMMENDATIONS[type] || [];
}

// ============================================================================
// Template Generators
// ============================================================================

/**
 * Generate a complete document from template
 * ENHANCED: Now includes richer examples and type-specific sections
 */
export function generateDocument(config: TemplateConfig): string {
  const today = new Date().toISOString().split('T')[0];
  const recommendations = getSectionRecommendations(config.type);

  // Generate type-specific sections
  const typeSections = generateTypeSections(config.type, config);

  return `---
# === IDENTITY (Required) ===
title: "${config.title}"
doc-id: ${config.docId}
aliases:
${config.aliases?.map(a => `  - ${a}`).join('\n') || `  - ${suggestAliases(config.title).map(a => `${a}`).join('\n  - ')}`}

# === STATUS & TRUST (Required) ===
status: current
confidence: high
last-verified: ${today}
verification-method: code-review

# === SCOPE (Recommended) ===
applies-to:
  - component: ${config.component || 'TODO: Component name'}
  - modules: [${config.modules?.join(', ') || 'TODO: module paths'}]
  - versions: ">=1.0.0"

# === DEPENDENCIES (Required) ===
sources:
${config.sources.map(s => `  - ${s}`).join('\n')}
${config.dependsOn ? `depends-on:\n${config.dependsOn.map(d => `  - doc-id: ${d.docId}`).join('\n')}` : `depends-on:
  - # doc-id: related-system-doc (docs this REQUIRES to understand)`}
${config.relatedDocs ? `related-docs:\n${config.relatedDocs.map(d => `  - ${d}`).join('\n')}` : `related-docs:
  - # architecture/system-overview.md (for broader context)`}
${config.prerequisites ? `prerequisites:\n${config.prerequisites.map(p => `  - ${p}`).join('\n')}` : `prerequisites:
  - # docs to read BEFORE this one`}

# === DISCOVERABILITY (Required) ===
tags:
  - ${config.type}
${generateTagSuggestions(config.type).map(t => `  - ${t}`).join('\n')}
keywords:
${config.keywords?.map(k => `  - ${k}`).join('\n') || generateKeywordSuggestions(config.title, config.type).map(k => `  - ${k}`).join('\n')}
ai-summary: >
${config.aiSummary || `  ${generateAiSummaryPrompt(config.type, config.title)}`}

# === HISTORY (Required) ===
created: ${today}
major-revisions:
  - date: ${today}
    change: Initial documentation
---

<!-- AI-CONTEXT: ${config.title} - ${getContextSuggestion(config.type)} -->
<!-- TRUST-LEVEL: High - Verified against code ${today} -->
<!-- SCOPE: Covers ${config.sources.join(', ')}. Does NOT cover [TODO: what's out of scope]. -->

# ${config.title}

> **Quick Reference**: ${generateQuickRefPrompt(config.type, config)}

## Overview

${generateOverviewPrompt(config.type)}

${typeSections}

## Related Documentation

${config.relatedDocs?.map(d => `- [Related Doc](${d}) - TODO: Brief description`).join('\n') || '- [System Overview](../architecture/system-overview.md) - Broader system context\n- TODO: Add links to related docs'}

## History

### ${today}: Initial documentation
- Created comprehensive documentation
- Documented main features and API
- Verified against source files

## Verification Notes

**Last verified**: ${today}
**Method**: code-review

**Verified items:**
- TODO: List specific items verified against code
- Function signatures confirmed
- Behavior matches documentation

**If you suspect drift:**
1. Check source files in frontmatter \`sources\`
2. Compare signatures to actual code
3. Run any examples to confirm they work
`;
}

/**
 * Generate type-specific sections for a document
 */
function generateTypeSections(type: DocType, config: TemplateConfig): string {
  switch (type) {
    case 'backend':
      return generateBackendSections(config);
    case 'frontend':
      return generateFrontendSections(config);
    case 'api':
      return generateApiSections(config);
    case 'database':
      return generateDatabaseSections(config);
    case 'guide':
      return generateGuideSections(config);
    case 'architecture':
      return generateArchitectureSections(config);
    default:
      return generateGenericSections(config);
  }
}

function generateBackendSections(config: TemplateConfig): string {
  return `## Core Principles

1. **TODO: First Principle** - Explanation of why this design choice was made
2. **TODO: Second Principle** - Another key design tenet
3. **TODO: Third Principle** - Continue as needed

## System Components & Data Structures

### The Main Struct/Type

- **Location:** \`${config.sources[0] || 'path/to/file.rs'}\`
- **Function:** TODO: What role does this play in the system?

#### Structure

\`\`\`rust
// ${config.sources[0] || 'path/to/file.rs'}:LINE
pub struct MainType {
    pub field: FieldType,
    // TODO: Document each field
}
\`\`\`

## Architecture

\`\`\`mermaid
graph TD
    A[Input] --> B[${config.component || 'Component'}]
    B --> C[Output]
    B --> D[Database]
\`\`\`

TODO: Replace with actual architecture diagram showing data flow

## API Reference

### \`main_function(param: Type) -> ReturnType\`

TODO: Document the primary public interface.

\`\`\`rust
// ${config.sources[0] || 'path/to/file.rs'}:LINE-LINE
pub fn main_function(param: Type) -> ReturnType {
    // implementation
}
\`\`\`

## Developer Guide: Extending This System

Follow these steps to add new functionality:

### Step 1: TODO First Step

- **File:** \`path/to/file.rs\`
- **Action:** What to do
- **Details:** Why and how

### Step 2: TODO Second Step

Continue with numbered steps...

## Usage Examples

\`\`\`rust
// Example: Basic usage
let instance = MainType::new();
let result = instance.main_function(param);
\`\`\`

## Gotchas & Edge Cases

- **TODO: Edge Case 1** - Description and workaround
- **TODO: Thread Safety** - Notes on concurrent access
- **TODO: Error Handling** - How errors propagate
`;
}

function generateFrontendSections(config: TemplateConfig): string {
  // Detect if this is a store based on source paths or component name
  const isStore = config.sources.some(s =>
    s.includes('/stores/') || s.includes('Store.ts') || s.includes('store.ts')
  ) || config.component?.toLowerCase().includes('store');

  if (isStore) {
    return generateStoreSections(config);
  }

  return `## Component Hierarchy

\`\`\`
${config.component || 'ComponentName'}/
├── index.tsx          # Main component
├── SubComponent.tsx   # Child component
└── hooks/
    └── useComponentLogic.ts
\`\`\`

## Architecture

\`\`\`mermaid
graph LR
    A[User Action] --> B[${config.component || 'Component'}]
    B --> C[Store]
    C --> D[Backend API]
    D --> C
    C --> B
\`\`\`

## Props & State

### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| \`propName\` | \`string\` | Yes | TODO: Description |

### State Management

\`\`\`typescript
// From state store
const { data, isLoading } = useStore();
\`\`\`

## Usage Examples

\`\`\`tsx
// Basic usage
<${config.component || 'Component'} propName="value" />

// With all props
<${config.component || 'Component'}
  propName="value"
  optionalProp={true}
  onEvent={handleEvent}
/>
\`\`\`

## Styling Notes

- CSS framework/utility classes used: TODO
- Component library classes: TODO
- Custom styles location: \`src/styles/\` or similar

## Gotchas & Edge Cases

- **TODO: Loading States** - How loading is handled
- **TODO: Error Boundaries** - Error handling approach
`;
}

function generateStoreSections(config: TemplateConfig): string {
  const storeName = config.component || 'Store';
  const hookName = storeName.startsWith('use') ? storeName : `use${storeName}`;

  return `## Store Overview

This store manages state for ${config.title.toLowerCase()}.

## Architecture

\`\`\`mermaid
graph TD
    A[Components] -->|subscribe| B[${storeName}]
    B -->|state| A
    B -->|actions| C[Backend API]
    C -->|events| B
    D[Event Bus] -->|updates| B
\`\`\`

## State Shape

\`\`\`typescript
interface ${storeName}State {
  // TODO: Document state properties
  data: unknown;
  isLoading: boolean;
  error: string | null;
}
\`\`\`

## Actions

| Action | Parameters | Description |
|--------|------------|-------------|
| \`fetch\` | \`()\` | TODO: Description |
| \`update\` | \`(data)\` | TODO: Description |
| \`reset\` | \`()\` | TODO: Description |

## Selectors

| Selector | Returns | Description |
|----------|---------|-------------|
| \`selectAll\` | \`T[]\` | TODO: Description |
| \`selectById\` | \`T \\| undefined\` | TODO: Description |

## Usage Examples

\`\`\`typescript
// In a component
const { data, isLoading, fetch } = ${hookName}();

// Using selectors
const item = ${hookName}(state => state.selectById(id));

// Triggering actions
${hookName}.getState().fetch();
\`\`\`

## Event Subscriptions

This store subscribes to the following backend events:
- TODO: List events this store reacts to

## Gotchas & Edge Cases

- **TODO: Initialization** - When/how the store initializes
- **TODO: Persistence** - Any local storage or persistence behavior
- **TODO: Concurrent Updates** - How race conditions are handled
`;
}

function generateApiSections(config: TemplateConfig): string {
  return `## Architecture

\`\`\`mermaid
sequenceDiagram
    participant Client
    participant Server
    participant Database
    Client->>Server: Request
    Server->>Database: Query
    Database-->>Server: Data
    Server-->>Client: Response
\`\`\`

## Endpoints

### \`command_name\`

**Description:** TODO: What this command does

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| \`param\` | \`string\` | Yes | TODO |

**Returns:** \`ReturnType\`

**Example:**
\`\`\`typescript
// Frontend call
const result = await invoke('command_name', { param: 'value' });
\`\`\`

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| \`ErrorType\` | TODO: When this occurs | TODO: How to handle |

## Usage Examples

\`\`\`typescript
// Example: Full workflow
try {
  const result = await invoke('command_name', { param: 'value' });
  console.log('Success:', result);
} catch (error) {
  console.error('Failed:', error);
}
\`\`\`

## Gotchas & Edge Cases

- **TODO: Rate Limiting** - Any rate limit considerations
- **TODO: Caching** - Cache behavior
`;
}

function generateDatabaseSections(config: TemplateConfig): string {
  return `## Schema

\`\`\`mermaid
erDiagram
    TABLE1 ||--o{ TABLE2 : has
    TABLE1 {
        integer id PK
        text name
        datetime created_at
    }
    TABLE2 {
        integer id PK
        integer table1_id FK
        text value
    }
\`\`\`

## Tables

### \`table_name\`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| \`id\` | INTEGER | No | Primary key |
| \`name\` | TEXT | No | TODO |
| \`created_at\` | DATETIME | No | Creation timestamp |

**Indexes:**
- \`idx_table_name_column\` on \`(column)\`

## Query Examples

\`\`\`sql
-- Get all records
SELECT * FROM table_name WHERE condition;

-- Join example
SELECT t1.*, t2.value
FROM table1 t1
JOIN table2 t2 ON t1.id = t2.table1_id;
\`\`\`

## Migrations

| Migration | Date | Description |
|-----------|------|-------------|
| \`001_initial\` | ${new Date().toISOString().split('T')[0]} | Created initial schema |

## Gotchas & Edge Cases

- **TODO: Performance** - Query optimization notes
- **TODO: Constraints** - Unique constraints, check constraints
`;
}

function generateGuideSections(config: TemplateConfig): string {
  return `## Prerequisites

Before starting, ensure you have:

- [ ] Prerequisite 1
- [ ] Prerequisite 2
- [ ] Required knowledge/reading

## Steps

### Step 1: First Step Title

TODO: Detailed instructions for the first step.

\`\`\`bash
# Command to run
example command
\`\`\`

### Step 2: Second Step Title

TODO: Continue with numbered steps.

### Step 3: Verification

Verify your setup by:

1. Check that X works
2. Confirm Y is configured

## Troubleshooting

### Issue: Common Problem

**Symptom:** What the user sees
**Cause:** Why it happens
**Solution:** How to fix it

## Next Steps

After completing this guide:

- [ ] Try the [Advanced Guide](link)
- [ ] Read about [Related Topic](link)
`;
}

function generateArchitectureSections(config: TemplateConfig): string {
  return `## System Context

Where this system fits in the broader application:

\`\`\`mermaid
graph TB
    subgraph External
        User[User]
    end
    subgraph Application
        FE[Frontend]
        BE[Backend]
        DB[(Database)]
    end
    User --> FE
    FE --> BE
    BE --> DB
\`\`\`

## Components

### Component 1

- **Responsibility:** TODO
- **Location:** \`path/to/component\`
- **Dependencies:** Other components it relies on

### Component 2

Continue for each major component...

## Data Flow

\`\`\`mermaid
sequenceDiagram
    participant A as Component A
    participant B as Component B
    participant C as Component C
    A->>B: Message 1
    B->>C: Message 2
    C-->>A: Response
\`\`\`

## Design Decisions

### Decision 1: Why We Chose X

**Context:** The situation that required a decision
**Decision:** What we decided
**Consequences:** Trade-offs and implications

## Trade-offs

| Aspect | Current Approach | Alternative | Why Current |
|--------|-----------------|-------------|-------------|
| TODO | What we do | What we could do | Why we chose this |
`;
}

function generateGenericSections(config: TemplateConfig): string {
  return `## Architecture

\`\`\`mermaid
graph TD
    A[Input] --> B[Processing]
    B --> C[Output]
\`\`\`

TODO: Replace with actual architecture diagram

## API Reference

### \`main_function(param: Type) -> ReturnType\`

TODO: Document public interfaces with exact signatures.

## Usage Examples

TODO: Add common usage patterns with working code.

## Gotchas & Edge Cases

- **TODO**: Describe non-obvious issues and workarounds
`;
}

// ============================================================================
// Helper Functions for Template Generation
// ============================================================================

function suggestAliases(title: string): string[] {
  const words = title.toLowerCase().split(/\s+/);
  const aliases: string[] = [];

  // Add kebab-case version
  aliases.push(words.join('-'));

  // Add concatenated version if multi-word
  if (words.length > 1) {
    aliases.push(words.join(''));
  }

  // Add acronym if 3+ words
  if (words.length >= 3) {
    aliases.push(words.map(w => w[0]).join(''));
  }

  return aliases.slice(0, 3);
}

function generateTagSuggestions(type: DocType): string[] {
  // Additional tags beyond the doc type (which is added separately in the template)
  // These are generic - users should customize for their stack
  const tagMap: Record<DocType, string[]> = {
    backend: ['server', 'async', 'service'],
    frontend: ['ui', 'component', 'view'],
    api: ['endpoints', 'interface', 'contract'],
    database: ['schema', 'persistence', 'queries'],
    datapack: ['minecraft', 'mcfunction', 'nbt'],
    guide: ['tutorial', 'howto', 'setup'],
    architecture: ['design', 'system', 'overview'],
    meta: ['standard', 'protocol', 'convention'],
  };
  return tagMap[type] || [];
}

function generateKeywordSuggestions(title: string, type: DocType): string[] {
  const keywords: string[] = [];

  // Add title words
  const words = title.toLowerCase().split(/\s+/);
  keywords.push(...words);

  // Add type-specific keywords (framework-agnostic)
  const typeKeywords: Record<DocType, string[]> = {
    backend: ['implementation', 'module', 'service', 'handler', 'function'],
    frontend: ['component', 'view', 'hook', 'store', 'ui'],
    api: ['endpoint', 'handler', 'request', 'response', 'interface'],
    database: ['table', 'query', 'migration', 'index', 'column'],
    datapack: ['function', 'scoreboard', 'tag', 'nbt', 'command'],
    guide: ['how to', 'tutorial', 'step by step', 'setup', 'configure'],
    architecture: ['design', 'pattern', 'flow', 'component', 'system'],
    meta: ['standard', 'rule', 'guideline', 'format', 'convention'],
  };

  keywords.push(...(typeKeywords[type] || []).slice(0, 3));

  return keywords.slice(0, 10);
}

function generateAiSummaryPrompt(type: DocType, title: string): string {
  const prompts: Record<DocType, string> = {
    backend: `This document covers the ${title} backend implementation.
  [Sentence 2: What problem does it solve?]
  [Sentence 3: Key types/structs involved]
  [Sentence 4: How it integrates with other systems]
  [Sentence 5: When would you read this doc?]`,
    frontend: `This document covers the ${title} frontend component.
  [Sentence 2: What UI functionality does it provide?]
  [Sentence 3: Key props and state management]
  [Sentence 4: How it connects to stores/backend]
  [Sentence 5: When would you read this doc?]`,
    api: `This document covers the ${title} API/commands.
  [Sentence 2: What operations are available?]
  [Sentence 3: Request/response patterns]
  [Sentence 4: Error handling approach]
  [Sentence 5: When would you read this doc?]`,
    database: `This document covers the ${title} database schema.
  [Sentence 2: What data does it store?]
  [Sentence 3: Key relationships and indexes]
  [Sentence 4: Query patterns]
  [Sentence 5: When would you read this doc?]`,
    datapack: `This document covers the ${title} Minecraft datapack.
  [Sentence 2: What game functionality does it add?]
  [Sentence 3: Key function tags and scoreboards]
  [Sentence 4: How it exports data to the app]
  [Sentence 5: When would you read this doc?]`,
    guide: `This guide walks through ${title}.
  [Sentence 2: What will you accomplish?]
  [Sentence 3: Prerequisites needed]
  [Sentence 4: Estimated time/complexity]
  [Sentence 5: What to do after completing this guide]`,
    architecture: `This document describes the ${title} architecture.
  [Sentence 2: What systems/components does it cover?]
  [Sentence 3: Key design decisions]
  [Sentence 4: How it fits in the broader system]
  [Sentence 5: When would you read this doc?]`,
    meta: `This meta-document defines ${title}.
  [Sentence 2: What does this standard govern?]
  [Sentence 3: Key rules or guidelines]
  [Sentence 4: Who should follow this]
  [Sentence 5: When would you read this doc?]`,
  };
  return prompts[type] || `TODO: Write 3-5 sentences about ${title}`;
}

function getContextSuggestion(type: DocType): string {
  const suggestions: Record<DocType, string> = {
    backend: 'Backend implementation and architecture',
    frontend: 'Frontend component structure and behavior',
    api: 'API interface and data contracts',
    database: 'Database schema and query patterns',
    datapack: 'Minecraft datapack functions and data flow',
    guide: 'Step-by-step instructions for a specific task',
    architecture: 'System design and component relationships',
    meta: 'Documentation standard or protocol definition',
  };
  return suggestions[type] || 'System documentation';
}

function generateQuickRefPrompt(type: DocType, config: TemplateConfig): string {
  const title = config.title;
  const entryPoint = config.sources[0] || 'TODO: entry point';
  const component = config.component || 'TODO: component';

  const prompts: Record<DocType, string> = {
    backend: `Entry point: \`${entryPoint}\`. Key types: TODO. Use this when you need to understand or modify ${title.toLowerCase()}.`,
    frontend: `Component: \`${component}\`. Source: \`${entryPoint}\`. Use this when building UI that involves ${title.toLowerCase()}.`,
    api: `Source: \`${entryPoint}\`. Endpoints: TODO. Use this when integrating frontend with ${title.toLowerCase()}.`,
    database: `Source: \`${entryPoint}\`. Tables: TODO. Use this when querying or modifying ${title.toLowerCase()} data.`,
    datapack: `Functions: \`namespace:function\`. Scoreboards: \`objective\`. Use this when debugging datapack behavior.`,
    guide: `Prerequisites: [list]. Follow this guide to ${title.toLowerCase()}.`,
    architecture: `Components: [list]. Use this to understand how ${title.toLowerCase()} works at a high level.`,
    meta: `Scope: [what this covers]. Use this when creating or updating documentation.`,
  };
  return prompts[type] || `TODO: One-paragraph summary of ${title}`;
}

function generateOverviewPrompt(type: DocType): string {
  return `TODO: Write 2-3 paragraphs explaining:
- What is this ${type}? What does it do?
- What problem does it solve? Why does it exist?
- How does it fit into the larger system?`;
}

/**
 * Generate just the frontmatter template
 */
export function generateFrontmatter(config: TemplateConfig): string {
  const today = new Date().toISOString().split('T')[0];

  return `---
# === IDENTITY (Required) ===
title: "${config.title}"
doc-id: ${config.docId}
aliases:
${config.aliases?.map(a => `  - ${a}`).join('\n') || suggestAliases(config.title).map(a => `  - ${a}`).join('\n')}

# === STATUS & TRUST (Required) ===
status: current
confidence: high
last-verified: ${today}
verification-method: code-review

# === SCOPE (Recommended) ===
applies-to:
  - component: ${config.component || 'ComponentName'}
  - modules: [${config.modules?.join(', ') || 'path/to/modules/*'}]

# === DEPENDENCIES (Required) ===
sources:
${config.sources.map(s => `  - ${s}`).join('\n')}
related-docs:
${config.relatedDocs?.map(d => `  - ${d}`).join('\n') || '  - # Add related doc paths'}

# === DISCOVERABILITY (Required) ===
tags:
  - ${config.type}
${generateTagSuggestions(config.type).map(t => `  - ${t}`).join('\n')}
keywords:
${generateKeywordSuggestions(config.title, config.type).map(k => `  - ${k}`).join('\n')}
ai-summary: >
  ${generateAiSummaryPrompt(config.type, config.title)}

# === HISTORY (Required) ===
created: ${today}
major-revisions:
  - date: ${today}
    change: Initial documentation
---`;
}

/**
 * Generate the HTML context comments
 */
export function generateHtmlComments(
  context: string,
  trustLevel: string,
  scope: string
): string {
  return `<!-- AI-CONTEXT: ${context} -->
<!-- TRUST-LEVEL: ${trustLevel} -->
<!-- SCOPE: ${scope} -->`;
}

/**
 * Generate Quick Reference blockquote
 */
export function generateQuickReference(summary: string): string {
  return `> **Quick Reference**: ${summary}`;
}

/**
 * Generate a History section entry
 */
export function generateHistoryEntry(date: string, title: string, changes: string[]): string {
  return `### ${date}: ${title}
${changes.map(c => `- ${c}`).join('\n')}`;
}

/**
 * Generate a Verification Notes section
 */
export function generateVerificationNotes(
  date: string,
  method: string,
  verifiedItems: string[],
  driftChecks: string[]
): string {
  return `## Verification Notes

**Last verified**: ${date}
**Method**: ${method}

**Verified items:**
${verifiedItems.map(item => `- ${item}`).join('\n')}

**If you suspect drift:**
${driftChecks.map((check, i) => `${i + 1}. ${check}`).join('\n')}`;
}

// ============================================================================
// Exemplary Template (Filled-in Example)
// ============================================================================

/**
 * Generate an exemplary filled-in template showing what a GOOD doc looks like
 */
export function generateExemplaryTemplate(): string {
  return `---
# === IDENTITY (Required) ===
title: "Event System Architecture"
doc-id: backend-event-bus
aliases:
  - event-system
  - eventbus
  - message-bus
  - app-events

# === STATUS & TRUST (Required) ===
status: current
confidence: high
last-verified: 2026-01-06
verification-method: code-review

# === SCOPE (Recommended) ===
applies-to:
  - component: EventBus
  - modules: [src-tauri/src/core/events/*, src-tauri/common-types/src/lib.rs]
  - versions: ">=1.0.0"

# === DEPENDENCIES (Required) ===
sources:
  - src-tauri/src/core/events/bus.rs
  - src-tauri/common-types/src/lib.rs
depends-on:
  - doc-id: architecture-system-overview
consumes:
  - doc-id: frontend-architecture-overview
related-docs:
  - architecture/2026-01-06-system-overview.md
  - frontend/2026-01-06-architecture-overview.md
prerequisites:
  - architecture/2026-01-06-system-overview.md

# === DISCOVERABILITY (Required) ===
tags:
  - backend
  - architecture
  - events
  - tokio
  - broadcast-channel
  - pub-sub
keywords:
  - event-driven architecture
  - publish subscribe
  - message bus
  - async communication
  - decoupled components
  - AppEvent
  - EventScope
  - EventDetails
  - LogEntry
  - broadcast channel
  - real-time updates
ai-summary: >
  Central event bus implementation using tokio broadcast channels.
  Defines the universal AppEvent envelope, EventScope for routing context,
  and EventDetails payload enum for extensible event types.
  Covers event processing pipeline, persistence strategy, and developer guide
  for adding new log event types. Reference for understanding event publishing,
  subscribing, and the complete event lifecycle.

# === HISTORY (Required) ===
created: 2025-07-02
original-file: docs/event-system.md
major-revisions:
  - date: 2026-01-06
    change: Migrated to new documentation standard with frontmatter
  - date: 2025-07-02
    change: Initial creation
---

<!-- AI-CONTEXT: Event bus architecture and event type definitions -->
<!-- TRUST-LEVEL: High - Verified against code 2026-01-06 -->
<!-- SCOPE: Covers EventBus, AppEvent, EventScope, EventDetails, log event types. Does NOT cover frontend event handling or database persistence details. -->

# Event System Architecture

> **Quick Reference**: Entry point: \`src-tauri/src/core/events/bus.rs\`. Key types: \`AppEvent\`, \`EventScope\`, \`EventDetails\`. Use this when you need to understand event flow, add new event types, or debug event-related issues.

## Overview

This document outlines the architecture for the application's central event bus and the canonical event structures. The EventBus is the primary mechanism for decoupled, real-time communication between different parts of the backend and the frontend.

The event system uses a publish-subscribe pattern built on Tokio's broadcast channels, allowing multiple producers and consumers to communicate without direct coupling. All events are wrapped in a universal \`AppEvent\` envelope that provides consistent metadata for routing and tracing.

## Core Principles

1. **Universal Envelope:** All events are wrapped in a single \`AppEvent\` struct with common metadata
2. **Modular Payloads:** Event details are contained in the \`EventDetails\` enum, allowing extensibility
3. **Decoupling:** Components communicate through events, not direct references
4. **Type Safety:** All structures are rigidly defined in Rust for compile-time guarantees

## System Components & Data Structures

### 1. The EventBus

- **Location:** \`src-tauri/src/core/events/bus.rs\`
- **Function:** Thread-safe, multi-producer, multi-subscriber broadcast channel
- **Capacity:** 1024 events (configurable via \`EVENT_BUS_CAPACITY\`)

\`\`\`rust
// src-tauri/src/core/events/bus.rs:10-13
pub struct EventBus {
    sender: broadcast::Sender<AppEvent>,
    app_handle: Option<AppHandle>,
}
\`\`\`

### 2. The AppEvent Envelope

- **Location:** \`src-tauri/common-types/src/lib.rs\`

\`\`\`rust
pub struct AppEvent {
    pub id: Uuid,                    // Unique event ID
    pub timestamp: DateTime<Utc>,    // When event was created
    pub source: String,              // Origin component
    pub scope: EventScope,           // Routing context
    pub details: EventDetails,       // Event payload
}
\`\`\`

## Architecture

\`\`\`mermaid
graph TD
    LP[Log Processor] -->|publish| EB[EventBus]
    SM[Server Monitor] -->|publish| EB
    DP[Datapack Poller] -->|publish| EB
    EB -->|emit| FE[Frontend via Tauri]
    EB -->|subscribe| PS[Persistence Service]
    EB -->|subscribe| NS[Notification Service]
\`\`\`

## Developer Guide: Adding a New Event Type

### Step 1: Define the Pattern (if log-derived)

\`\`\`toml
# src-tauri/resources/patterns/vanilla/common.toml
[[pattern]]
name = "PlayerLeveledUp"
regex = '(?P<player>\\\\w+) has reached level (?P<level>\\\\d+)'
\`\`\`

### Step 2: Create the Details Struct

\`\`\`rust
// src-tauri/common-types/src/lib.rs
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlayerLeveledUpDetails {
    pub player: String,
    pub level: String,
}
\`\`\`

### Step 3: Add Enum Variant

\`\`\`rust
pub enum LogEventDetails {
    // ... existing variants
    PlayerLeveledUp(PlayerLeveledUpDetails),
}
\`\`\`

### Step 4: Implement Parser Match Arm

\`\`\`rust
// src-tauri/src/core/minecraft/log_parser.rs
"PlayerLeveledUp" => LogEventDetails::PlayerLeveledUp(PlayerLeveledUpDetails {
    player: get_capture("player"),
    level: get_capture("level"),
}),
\`\`\`

## Usage Examples

\`\`\`rust
// Publishing an event
event_bus.publish(AppEvent {
    id: Uuid::new_v4(),
    timestamp: Utc::now(),
    source: "my-service".to_string(),
    scope: EventScope {
        server_name: "vanilla-1-21-1".to_string(),
        world_name: Some("world".to_string()),
    },
    details: EventDetails::System(SystemEventDetails::ContainerStatusChanged {
        old_state: "stopped".to_string(),
        new_state: "running".to_string(),
    }),
});

// Subscribing to events
let mut receiver = event_bus.subscribe();
while let Ok(event) = receiver.recv().await {
    match event.details {
        EventDetails::Log(log_entry) => { /* handle log */ }
        EventDetails::System(sys) => { /* handle system event */ }
    }
}
\`\`\`

## Gotchas & Edge Cases

- **Channel Overflow:** If subscribers fall behind, oldest events are dropped (broadcast channel behavior)
- **No Frontend Handle:** If \`app_handle\` is None, events still flow to backend subscribers but not to frontend
- **Serialization:** All event types must be serializable for frontend emission

## Related Documentation

- [System Overview](../architecture/2026-01-06-system-overview.md) - Broader system context
- [Log Parsing System](./2026-01-06-log-parsing.md) - How log events are created
- [Frontend Architecture](../frontend/2026-01-06-architecture-overview.md) - How frontend consumes events

## History

### 2026-01-06: Verification and type corrections
- Verified against source code
- Corrected AppEvent.id type from String to Uuid
- Corrected AppEvent.timestamp type from String to DateTime<Utc>

### 2025-07-02: Initial creation
- Created comprehensive event system documentation

## Verification Notes

**Last verified**: 2026-01-06
**Method**: code-review

**Verified items:**
- AppEvent struct fields and types (id: Uuid, timestamp: DateTime<Utc>)
- EventScope struct (server_name: String, world_name: Option<String>)
- EventDetails enum variants (Log, System implemented)
- EventBus implementation in bus.rs (broadcast channel, capacity 1024)

**If you suspect drift:**
1. Check \`src-tauri/common-types/src/lib.rs\` for struct definitions
2. Check \`src-tauri/src/core/events/bus.rs\` for bus implementation
3. Verify EVENT_BUS_CAPACITY constant (currently 1024)
`;
}

// ============================================================================
// Mermaid Diagram Templates
// ============================================================================

/**
 * Generate a data flow diagram
 */
export function generateDataFlowDiagram(
  steps: Array<{ id: string; label: string; next?: string }>
): string {
  let mermaid = '```mermaid\ngraph LR\n';
  for (const step of steps) {
    if (step.next) {
      mermaid += `    ${step.id}[${step.label}] --> ${step.next}\n`;
    }
  }
  mermaid += '```';
  return mermaid;
}

/**
 * Generate a component architecture diagram
 */
export function generateArchitectureDiagram(
  components: Array<{ id: string; label: string; children?: string[] }>
): string {
  let mermaid = '```mermaid\ngraph TD\n';
  for (const component of components) {
    if (component.children) {
      for (const child of component.children) {
        mermaid += `    ${component.id}[${component.label}] --> ${child}\n`;
      }
    }
  }
  mermaid += '```';
  return mermaid;
}

/**
 * Generate a state diagram
 */
export function generateStateDiagram(
  states: Array<{ from: string; to: string; event: string }>
): string {
  let mermaid = '```mermaid\nstateDiagram-v2\n';
  for (const transition of states) {
    mermaid += `    ${transition.from} --> ${transition.to}: ${transition.event}\n`;
  }
  mermaid += '```';
  return mermaid;
}

/**
 * Generate a sequence diagram
 */
export function generateSequenceDiagram(
  participants: string[],
  messages: Array<{ from: string; to: string; message: string }>
): string {
  let mermaid = '```mermaid\nsequenceDiagram\n';
  for (const p of participants) {
    mermaid += `    participant ${p}\n`;
  }
  for (const msg of messages) {
    mermaid += `    ${msg.from}->>+${msg.to}: ${msg.message}\n`;
  }
  mermaid += '```';
  return mermaid;
}

// ============================================================================
// Index Entry Templates
// ============================================================================

/**
 * Generate a Source to Doc Map entry
 */
export function generateSourceMapEntry(
  sourceFile: string,
  docName: string,
  docPath: string,
  lastVerified: string,
  isCanonical: boolean = false
): string {
  const canonical = isCanonical ? ' ⭐' : '';
  return `| \`${sourceFile}\` | [${docName}](${docPath})${canonical} | ${lastVerified} | ✅ |`;
}

/**
 * Generate a Category table entry
 */
export function generateCategoryEntry(
  docFilename: string,
  docPath: string,
  status: string,
  lastVerified: string,
  trust: string = '✅'
): string {
  return `| [${docFilename}](${docPath}) | ${status} | ${lastVerified} | ${trust} |`;
}

/**
 * Generate a Redirect Map entry
 */
export function generateRedirectEntry(
  oldPath: string,
  newPath: string,
  movedDate: string
): string {
  return `| \`${oldPath}\` | \`${newPath}\` | ${movedDate} |`;
}

/**
 * Generate an Archive section entry
 */
export function generateArchiveEntry(
  archivedName: string,
  archivePath: string,
  originalName: string,
  archiveDate: string,
  archiveType: string
): string {
  return `| [${archivedName}](${archivePath}) | \`${originalName}\` | ${archiveDate} | ${archiveType} |`;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Suggest a doc-id based on title and type
 */
export function suggestDocId(title: string, type: DocType): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();

  return `${type}-${slug}`;
}

/**
 * Generate a filename with date prefix
 */
export function generateFilename(title: string): string {
  const today = new Date().toISOString().split('T')[0];
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();

  return `${today}-${slug}.md`;
}
