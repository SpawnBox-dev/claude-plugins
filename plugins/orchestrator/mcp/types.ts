// ── Note type constants ──────────────────────────────────────────────

export const NOTE_TYPES = [
  "decision",
  "commitment",
  "insight",
  "architecture",
  "open_thread",
  "risk",
  "dependency",
  "convention",
  "anti_pattern",
  "autonomy_recipe",
  "quality_gate",
  "tool_capability",
  "user_pattern",
  "checkpoint",
  "work_item",
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const RELATIONSHIP_TYPES = [
  "depends_on",
  "conflicts_with",
  "supersedes",
  "related_to",
  "blocks",
  "enables",
  "part_of",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const WORK_ITEM_STATUSES = [
  "proposed",
  "planned",
  "active",
  "blocked",
  "done",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const WORK_ITEM_PRIORITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "backlog",
] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const STRENGTH_LEVELS = ["weak", "moderate", "strong"] as const;
export type StrengthLevel = (typeof STRENGTH_LEVELS)[number];

export const BRIEFING_SECTIONS = [
  "work_items",
  "open_threads",
  "decisions",
  "neglected",
  "drift",
  "user_model",
  "cross_project",
  "cross_session",
  "checkpoint",
] as const;
export type BriefingSection = (typeof BRIEFING_SECTIONS)[number];

export const DIMENSIONS = [
  "communication_style",
  "decision_pattern",
  "strength",
  "blind_spot",
  "preference",
  "intent_pattern",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const TRAJECTORIES = ["improving", "stable", "regressing"] as const;
export type Trajectory = (typeof TRAJECTORIES)[number];

export const AUTONOMY_LEVELS = ["sparse", "developing", "mature"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

// ── Routing constants ────────────────────────────────────────────────

/** Types that always go to the global (cross-project) DB */
export const GLOBAL_TYPES: NoteType[] = ["user_pattern", "tool_capability"];

/** Types that CAN be global if they apply across projects */
export const MAYBE_GLOBAL_TYPES: NoteType[] = [
  "anti_pattern",
  "autonomy_recipe",
  "quality_gate",
  "convention",
];

// ── Interfaces ───────────────────────────────────────────────────────

export interface Note {
  id: string;
  type: NoteType;
  content: string;
  keywords: string[];
  confidence: ConfidenceLevel;
  created_at: string;
  updated_at: string;
  source_conversation: string | null;
  superseded_by: string | null;
  is_global: boolean;
  status: WorkItemStatus | null;
  priority: WorkItemPriority | null;
  due_date: string | null;
}

export interface NoteSummary {
  id: string;
  type: NoteType;
  content: string;
  confidence: ConfidenceLevel;
  created_at: string;
  keywords: string[];
  tags: string | null;
  status: WorkItemStatus | null;
  priority: WorkItemPriority | null;
  due_date: string | null;
}

export interface Link {
  id: string;
  from_note_id: string;
  to_note_id: string;
  relationship: RelationshipType;
  strength: StrengthLevel;
  created_at: string;
}

export interface UserModelEntry {
  id: string;
  dimension: Dimension;
  observation: string;
  evidence_count: number;
  confidence: ConfidenceLevel;
  trajectory: Trajectory;
  first_observed: string;
  last_observed: string;
}

export interface AutonomyScore {
  level: AutonomyLevel;
  score: number;
  dimension_scores: Record<string, number>;
  last_calibrated: string;
}

export interface CrossSessionUpdate {
  new_notes: Array<{
    id: string;
    type: string;
    content: string;
    tags: string | null;
    created_at: string;
    source_session: string;
  }>;
  hot_notes: Array<{
    id: string;
    type: string;
    content: string;
    tags: string | null;
    distinct_sessions: number;
    surfacings: number;
  }>;
  active_session_count: number;
  since: string | null;
}

export interface Briefing {
  open_threads: NoteSummary[];
  recent_decisions: NoteSummary[];
  active_work: NoteSummary[];
  blocked_work: NoteSummary[];
  recently_completed: NoteSummary[];
  overdue_work: NoteSummary[];
  neglected_areas: string[];
  drift_warning: string | null;
  user_model_summary: string[];
  user_profile: UserProfileEntry[];
  suggested_focus: string | null;
  suggested_intensity: "strategic" | "tactical" | "trivial";
  is_first_run: boolean;
  cross_session: CrossSessionUpdate | null;
}

export interface UserProfileEntry {
  dimension: Dimension;
  observation: string;
  confidence: ConfidenceLevel;
  trajectory: Trajectory;
  evidence_count: number;
}

export interface Checkpoint {
  id: string;
  conversation_id: string;
  summary: string;
  open_questions: string[];
  next_steps: string[];
  created_at: string;
}

export interface ContextPackage {
  conventions: NoteSummary[];
  tool_capabilities: NoteSummary[];
  anti_patterns: NoteSummary[];
  quality_gates: NoteSummary[];
  architecture: NoteSummary[];
  constraints: NoteSummary[];
  recent_decisions: NoteSummary[];
}
