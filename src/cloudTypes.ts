// Postgres row types — narrow subset duplicated from src/cloud/types.ts so the
// MCP package builds independently of the main app. Only the rows we actually
// touch from MCP tools (nodes, edges, projects, project_nodes, workspaces,
// workspace_memberships, ideas, idea_nodes) are mirrored here. Add more as the
// 19.4 tool-parity wave expands.
//
// Field names are snake_case to match what supabase-js returns.

export type NodeStatus = 'open' | 'validated' | 'archived';
export type ConceptStanding = 'unknown' | 'novel' | 'emerging' | 'established';
export type EdgeKind =
  | 'partition'
  | 'k-ref'
  | 'semantic-adjacency'
  | 'derived-from'
  | 'imported-from';
export type ProjectLifecycle = 'active' | 'paused' | 'completed' | 'abandoned';
export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer';

export interface WorkspaceRow {
  id: string;
  external_id: string | null;
  name: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMembershipRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
}

export interface NodeRow {
  id: string;
  external_id: string | null;
  workspace_id: string;
  parent_id: string | null;
  label: string;
  description: string;
  partition_attribute: string | null;
  rationale: string | null;
  self_critique: string | null;
  operator_family: string | null;
  operator_principle: string | null;
  status: NodeStatus;
  starred: boolean;
  standing: ConceptStanding;
  standing_rationale: string | null;
  standing_assessed_at: string | null;
  project_id: string | null;
  position_x: number | null;
  position_y: number | null;
  embedding: number[] | null;
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface EdgeRow {
  id: string;
  external_id: string | null;
  workspace_id: string;
  from_id: string;
  to_id: string;
  kind: EdgeKind;
  weight: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  external_id: string | null;
  workspace_id: string;
  name: string;
  brief: string;
  direction: string | null;
  lifecycle: ProjectLifecycle;
  root_node_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectNodeRow {
  id: string;
  project_id: string;
  node_id: string;
  position: number;
  created_at: string;
}

export interface IdeaRow {
  id: string;
  external_id: string | null;
  workspace_id: string;
  name: string;
  color: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaNodeRow {
  id: string;
  idea_id: string;
  node_id: string;
  position: number;
  created_at: string;
}

// A flat, agent-friendly view of a Node (drops position/embedding) — same
// shape the legacy snapshot path produced.
export interface NodeView {
  id: string;
  label: string;
  status: NodeStatus;
  starred: boolean;
  parentId: string | null;
  partitionAttribute: string | null;
  tags: string[];
  updatedAt: string;
  description?: string;
  rationale?: string | null;
  standing?: ConceptStanding;
}

// Phase 19.4 — cloud-side audit log row (added in migration 0015). Append-only
// (the MCP only inserts; the webapp reads workspace-level rows via the
// list_recent_decisions / SessionLog surfaces).
export type ProvenanceOriginCloud =
  | 'manual'
  | 'mcp'
  | 'llm-conversation'
  | 'asit'
  | 'triz'
  | 'contradiction'
  | 'freeform'
  | 'combine'
  | 'imported';

export interface ProvenanceRow {
  id: string;
  external_id: string | null;
  workspace_id: string;
  node_id: string;
  origin: ProvenanceOriginCloud;
  operator_key: string | null;
  source_refs: string[];
  llm_json: Record<string, unknown> | null;
  created_by: 'user' | 'agent' | 'system';
  analysis_id: string | null;
  analysis_tool: string | null;
  timestamp_ms: number;
  created_at: string;
}
