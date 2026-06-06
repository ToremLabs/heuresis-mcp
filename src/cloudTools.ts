// Heuresis MCP — cloud-backed tool implementations.
//
// Every read/write goes through `supabase-js` against the user's
// authenticated session. RLS in the database is the security boundary — the
// MCP has exactly the user's permissions, nothing more, nothing less.
//
// Each tool's INPUT shape MIRRORS the matching webapp tool in
// `src/agent/tools.ts` so an agent that uses both surfaces sees a uniform
// contract. Outputs mirror the legacy snapshot-mode shapes from
// `mcp-server/src/tools.ts` where one existed, so existing prompts that
// reference the snapshot shape keep working.
//
// Phase 19.1 shipped 8 tools (the reads + add/update/link). Phase 19.4
// brings the remaining write surface to parity with src/agent/tools.ts:
//
//   reads added:
//     get_workspace_summary, list_recent_decisions, list_concepts,
//     list_edges, find_concepts
//   writes added:
//     validate_concept, set_standing, archive_concept, unarchive_concept,
//     star_concept, remove_concept, bulk_add_concepts, set_parent,
//     rename_idea, recolor_idea, set_idea_members, create_idea,
//     add_to_idea, delete_idea, create_project, update_project,
//     delete_project, add_kref
//
// Skipped (in-browser-only — no server analog):
//   * focus_on_canvas — fires a DOM CustomEvent in the webapp.
//   * tidy_layout — UI affordance, no DB effect.
//   * reconcile_edges — webapp-only data healing; cloud edges are already
//     normalised.
//   * undo — session-local Zustand undo stack; no DB-side analog.
//   * find_in_files — needs in-browser embeddings; ships with operator
//     parity in Phase 19.5.
//   * add_k_node / add_c_node_disciplined / add_parking_lot_item / reflect
//     — C-K discipline tools that are sequenced add_concept + update_concept
//     calls with project-coverage gating; the MCP-side agent can drive that
//     sequence using the primitives directly.
//
// Every WRITE tool stamps a public.provenance row (added in migration 0015)
// with origin='mcp' so the Inspector / session log shows which surface made
// the change. The stamp is best-effort: a failed provenance insert never
// fails the underlying write.

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ConceptStanding,
  EdgeKind,
  EdgeRow,
  IdeaRow,
  IdeaNodeRow,
  NodeRow,
  NodeStatus,
  NodeView,
  ProjectRow,
  ProjectNodeRow,
  ProvenanceOriginCloud,
} from './cloudTypes.js';
import { unwrap, unwrapMaybe, getActiveDeviceName } from './cloudClient.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MAX_RESULTS = 50;
const detailArg = z
  .enum(['compact', 'full'])
  .default('compact')
  .describe(
    "'compact' drops description/rationale to keep the payload small; 'full' includes them.",
  );

function nodeView(n: NodeRow, detail: 'compact' | 'full' = 'full'): NodeView {
  const base: NodeView = {
    id: n.id,
    label: n.label,
    status: n.status,
    starred: n.starred,
    parentId: n.parent_id,
    partitionAttribute: n.partition_attribute,
    tags: n.tags ?? [],
    updatedAt: n.updated_at,
    standing: n.standing,
  };
  if (detail === 'compact') return base;
  return { ...base, description: n.description, rationale: n.rationale };
}

/**
 * Resolve the workspace the MCP session should operate against. v1 ships
 * with single-workspace selection (spec §10.2): use the user's first
 * membership in alphabetical order by workspace name. A future
 * `npx @heuresis/mcp workspace <id>` command will swap this.
 */
async function resolveWorkspaceId(client: SupabaseClient): Promise<string> {
  const res = await client
    .from('workspaces')
    .select('id, name')
    .order('name', { ascending: true })
    .limit(1);
  const rows = unwrap(res) as { id: string; name: string }[];
  if (rows.length === 0) {
    throw new Error(
      'No workspaces visible to this account. Open the Heuresis webapp first to create or be invited to a workspace.',
    );
  }
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------

export const listProjectsInput = z.object({}).strict();

export async function listProjects(client: SupabaseClient) {
  const wsId = await resolveWorkspaceId(client);
  const projects = unwrap(
    await client
      .from('projects')
      .select('*')
      .eq('workspace_id', wsId)
      .order('updated_at', { ascending: false }),
  ) as ProjectRow[];
  const projectNodes = unwrap(
    await client
      .from('project_nodes')
      .select('project_id, node_id')
      .in(
        'project_id',
        projects.map((p) => p.id),
      ),
  ) as Pick<ProjectNodeRow, 'project_id' | 'node_id'>[];
  const countByProject = new Map<string, number>();
  for (const pn of projectNodes) {
    countByProject.set(pn.project_id, (countByProject.get(pn.project_id) ?? 0) + 1);
  }
  return {
    workspaceId: wsId,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      brief: p.brief,
      direction: p.direction,
      lifecycle: p.lifecycle,
      nodeCount: countByProject.get(p.id) ?? 0,
      rootNodeId: p.root_node_id,
    })),
  };
}

// ---------------------------------------------------------------------------
// get_project_graph
// ---------------------------------------------------------------------------

export const getProjectGraphInput = z
  .object({
    projectId: z.string(),
    includeArchived: z.boolean().default(false),
    detail: detailArg,
  })
  .strict();

export async function getProjectGraph(
  client: SupabaseClient,
  args: z.infer<typeof getProjectGraphInput>,
) {
  const projRes = await client
    .from('projects')
    .select('*')
    .eq('id', args.projectId)
    .maybeSingle();
  if (projRes.error) throw new Error(projRes.error.message);
  const project = projRes.data as ProjectRow | null;
  if (!project) return { error: `No project with id ${args.projectId}` };
  const memberRows = unwrap(
    await client
      .from('project_nodes')
      .select('node_id')
      .eq('project_id', project.id),
  ) as { node_id: string }[];
  const memberIds = memberRows.map((r) => r.node_id);
  if (memberIds.length === 0) {
    return {
      project: shapeProject(project),
      detail: args.detail,
      nodeCount: 0,
      edgeCount: 0,
      nodes: [],
      edges: [],
    };
  }
  const nodesRes = await client.from('nodes').select('*').in('id', memberIds);
  const nodes = (unwrap(nodesRes) as NodeRow[]).filter((n) =>
    args.includeArchived ? true : n.status !== 'archived',
  );
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  // Pull every edge whose endpoints are in this project. Two `in()` filters
  // in PostgREST require an `or()`.
  const edgesRes = await client
    .from('edges')
    .select('id, from_id, to_id, kind')
    .in('from_id', memberIds);
  const edges = (unwrap(edgesRes) as Pick<EdgeRow, 'id' | 'from_id' | 'to_id' | 'kind'>[])
    .filter((e) => nodeIdSet.has(e.from_id) && nodeIdSet.has(e.to_id))
    .map((e) => ({ from: e.from_id, to: e.to_id, kind: e.kind }));
  return {
    project: shapeProject(project),
    detail: args.detail,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: nodes.map((n) => nodeView(n, args.detail)),
    edges,
  };
}

function shapeProject(p: ProjectRow) {
  return {
    id: p.id,
    name: p.name,
    brief: p.brief,
    direction: p.direction,
    lifecycle: p.lifecycle,
    rootNodeId: p.root_node_id,
  };
}

// ---------------------------------------------------------------------------
// get_subtree
// ---------------------------------------------------------------------------

export const getSubtreeInput = z
  .object({
    rootId: z.string().min(1).optional(),
    id: z
      .string()
      .min(1)
      .optional()
      .describe('Alias for rootId — the concept to root the subtree at (use either).'),
    depth: z.number().int().min(0).max(6).default(3),
    detail: detailArg,
  })
  .strict()
  .refine((a) => Boolean(a.rootId ?? a.id), {
    message: 'Provide `id` (or `rootId`) — the concept to get the subtree for.',
    path: ['id'],
  })
  .transform((a) => ({
    rootId: (a.rootId ?? a.id) as string,
    depth: a.depth,
    detail: a.detail,
  }));

export async function getSubtree(
  client: SupabaseClient,
  args: z.infer<typeof getSubtreeInput>,
) {
  const rootRes = await client.from('nodes').select('*').eq('id', args.rootId).maybeSingle();
  if (rootRes.error) throw new Error(rootRes.error.message);
  const root = rootRes.data as NodeRow | null;
  if (!root) return { error: `No concept with id ${args.rootId}` };
  const wsId = root.workspace_id;
  // Pull ALL workspace nodes + partition edges in one shot, then walk in
  // memory. Cheaper than depth round-trips for any realistic workspace size,
  // and still covered by RLS.
  const allNodes = unwrap(
    await client.from('nodes').select('*').eq('workspace_id', wsId),
  ) as NodeRow[];
  const partitionEdges = unwrap(
    await client
      .from('edges')
      .select('from_id, to_id, kind')
      .eq('workspace_id', wsId)
      .eq('kind', 'partition'),
  ) as Pick<EdgeRow, 'from_id' | 'to_id' | 'kind'>[];
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const childrenByParent = new Map<string, Set<string>>();
  for (const n of allNodes) {
    if (n.parent_id) {
      const s = childrenByParent.get(n.parent_id) ?? new Set();
      s.add(n.id);
      childrenByParent.set(n.parent_id, s);
    }
  }
  for (const e of partitionEdges) {
    const s = childrenByParent.get(e.from_id) ?? new Set();
    s.add(e.to_id);
    childrenByParent.set(e.from_id, s);
  }
  const out: NodeRow[] = [];
  const seen = new Set<string>();
  let frontier: string[] = [args.rootId];
  for (let d = 0; d <= args.depth; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      if (seen.has(cur)) continue;
      seen.add(cur);
      const node = nodeById.get(cur);
      if (!node) continue;
      out.push(node);
      if (d < args.depth) {
        const kids = childrenByParent.get(cur);
        if (kids) for (const k of kids) if (!seen.has(k)) next.push(k);
      }
    }
    frontier = next;
  }
  return {
    rootId: args.rootId,
    depth: args.depth,
    detail: args.detail,
    nodeCount: out.length,
    nodes: out.map((n) => nodeView(n, args.detail)),
  };
}

// ---------------------------------------------------------------------------
// get_concept
// ---------------------------------------------------------------------------

export const getConceptInput = z
  .object({
    id: z.string(),
    includeAncestry: z.boolean().default(true),
    includeChildren: z.boolean().default(true),
    includeIdeaMemberships: z.boolean().default(true),
  })
  .strict();

export async function getConcept(
  client: SupabaseClient,
  args: z.infer<typeof getConceptInput>,
) {
  const nodeRes = await client.from('nodes').select('*').eq('id', args.id).maybeSingle();
  if (nodeRes.error) throw new Error(nodeRes.error.message);
  const node = nodeRes.data as NodeRow | null;
  if (!node) return { error: `No concept with id ${args.id}` };
  const out: Record<string, unknown> = { node: nodeView(node) };
  if (args.includeAncestry) {
    const chain: { id: string; label: string }[] = [];
    const seen = new Set<string>();
    let cur: string | null = node.parent_id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const p = unwrapMaybe(
        await client.from('nodes').select('id, label, parent_id').eq('id', cur).maybeSingle(),
      ) as { id: string; label: string; parent_id: string | null } | null;
      if (!p) break;
      chain.unshift({ id: p.id, label: p.label });
      cur = p.parent_id;
    }
    out.ancestry = chain;
  }
  if (args.includeChildren) {
    const kids = unwrap(
      await client
        .from('nodes')
        .select('id, label, status')
        .eq('parent_id', node.id),
    ) as { id: string; label: string; status: NodeStatus }[];
    out.children = kids;
  }
  if (args.includeIdeaMemberships) {
    // Fetch idea_nodes for this node, then idea rows separately. Joining
    // through PostgREST's `ideas(...)` shorthand returns the related row(s)
    // as an array which complicates typing here — two queries are cheap.
    const ideaNodeRows = unwrap(
      await client.from('idea_nodes').select('idea_id').eq('node_id', node.id),
    ) as { idea_id: string }[];
    const ideaIds = ideaNodeRows.map((r) => r.idea_id);
    if (ideaIds.length === 0) {
      out.ideaMemberships = [] as { id: string; name: string; color: string }[];
    } else {
      const ideas = unwrap(
        await client.from('ideas').select('id, name, color').in('id', ideaIds),
      ) as Pick<IdeaRow, 'id' | 'name' | 'color'>[];
      out.ideaMemberships = ideas.map((i) => ({ id: i.id, name: i.name, color: i.color }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// search_concepts (text-only for 19.1; semantic search is a 19.4 enhancement)
// ---------------------------------------------------------------------------

export const searchConceptsInput = z
  .object({
    query: z
      .string()
      .describe('Substring matched against label, description, tags, partitionAttribute.'),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(20),
    projectId: z
      .string()
      .optional()
      .describe('Restrict results to nodes belonging to this project.'),
    status: z.enum(['open', 'validated', 'archived']).optional(),
    detail: detailArg,
  })
  .strict();

export async function searchConcepts(
  client: SupabaseClient,
  args: z.infer<typeof searchConceptsInput>,
) {
  const q = args.query.trim();
  const wsId = await resolveWorkspaceId(client);
  // Restrict to a project if requested.
  let memberIds: string[] | null = null;
  if (args.projectId) {
    const rows = unwrap(
      await client
        .from('project_nodes')
        .select('node_id')
        .eq('project_id', args.projectId),
    ) as { node_id: string }[];
    memberIds = rows.map((r) => r.node_id);
    if (memberIds.length === 0) {
      return { query: q, total: 0, detail: args.detail, results: [] };
    }
  }
  let qb = client
    .from('nodes')
    .select('*')
    .eq('workspace_id', wsId)
    .order('updated_at', { ascending: false })
    .limit(args.limit);
  if (args.status) qb = qb.eq('status', args.status);
  if (memberIds) qb = qb.in('id', memberIds);
  if (q.length > 0) {
    // Server-side ilike over label/description/partition_attribute/rationale.
    // tags is text[] — PostgREST `cs.{value}` would require exact match, so
    // we filter tags client-side after fetching a slightly larger page.
    const escaped = q.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    qb = qb.or(
      [
        `label.ilike.${pattern}`,
        `description.ilike.${pattern}`,
        `partition_attribute.ilike.${pattern}`,
        `rationale.ilike.${pattern}`,
      ].join(','),
    );
  }
  const rows = unwrap(await qb) as NodeRow[];
  const lower = q.toLowerCase();
  // tag-match top-up: when the query string appears verbatim in a tag we
  // want to surface it even if it wasn't in any other column.
  let extra: NodeRow[] = [];
  if (q.length > 0 && rows.length < args.limit) {
    let tagQb = client
      .from('nodes')
      .select('*')
      .eq('workspace_id', wsId)
      .contains('tags', [q])
      .limit(args.limit);
    if (memberIds) tagQb = tagQb.in('id', memberIds);
    extra = unwrap(await tagQb) as NodeRow[];
  }
  const dedup = new Map<string, NodeRow>();
  for (const n of rows) dedup.set(n.id, n);
  for (const n of extra) dedup.set(n.id, n);
  const hits = Array.from(dedup.values())
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, args.limit)
    .map((n) => nodeView(n, args.detail));
  return { query: q || '', total: hits.length, detail: args.detail, results: hits, note: q ? undefined : 'Empty query — returned most-recently-updated concepts.' };
}

// ---------------------------------------------------------------------------
// add_concept  (write)
// ---------------------------------------------------------------------------
// Mirrors `add_concept` in src/agent/tools.ts. If `parentId` is given, the
// new node becomes a child of that node AND a partition edge is created so
// the canvas renders the line. The node is also added to the parent's
// project via `project_nodes`.

export const addConceptInput = z
  .object({
    label: z.string().min(1).max(140),
    description: z.string().max(2000).optional(),
    parentId: z.string().nullable().optional(),
    projectId: z
      .string()
      .optional()
      .describe(
        'Required when parentId is null/omitted AND the workspace has more than one project. Otherwise inferred.',
      ),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export async function addConcept(
  client: SupabaseClient,
  args: z.infer<typeof addConceptInput>,
) {
  const wsId = await resolveWorkspaceId(client);
  // Figure out parent + project.
  let parentNode: NodeRow | null = null;
  if (typeof args.parentId === 'string') {
    parentNode = unwrapMaybe(
      await client.from('nodes').select('*').eq('id', args.parentId).maybeSingle(),
    ) as NodeRow | null;
    if (!parentNode) return { error: `Parent ${args.parentId} not found.` };
  }
  let projectId = args.projectId ?? null;
  if (!projectId && parentNode) {
    // Inherit the parent's project (the first one if it sits in many).
    const rows = unwrap(
      await client
        .from('project_nodes')
        .select('project_id')
        .eq('node_id', parentNode.id)
        .limit(1),
    ) as { project_id: string }[];
    if (rows.length > 0) projectId = rows[0].project_id;
  }
  if (!projectId) {
    // Fall back to the workspace's only project. If there's >1 and the
    // caller didn't pass projectId we refuse rather than guess.
    const rows = unwrap(
      await client.from('projects').select('id').eq('workspace_id', wsId),
    ) as { id: string }[];
    if (rows.length === 0) {
      return {
        error:
          'No project in this workspace. Create one in the webapp first (or via create_project once that tool ships in 19.4).',
      };
    }
    if (rows.length > 1) {
      return {
        error:
          'Workspace has multiple projects — pass `projectId` to disambiguate (or set `parentId` so the project is inherited).',
      };
    }
    projectId = rows[0].id;
  }
  // Insert the node.
  const insertNode = unwrap(
    await client
      .from('nodes')
      .insert({
        workspace_id: wsId,
        parent_id: parentNode?.id ?? null,
        label: args.label,
        description: args.description ?? '',
        tags: args.tags ?? [],
        project_id: projectId,
      })
      .select('*')
      .single(),
  ) as NodeRow;
  // Link to the project.
  await client
    .from('project_nodes')
    .insert({ project_id: projectId, node_id: insertNode.id })
    .select('id')
    .maybeSingle();
  // Partition edge if parented.
  if (parentNode) {
    await client
      .from('edges')
      .insert({
        workspace_id: wsId,
        from_id: parentNode.id,
        to_id: insertNode.id,
        kind: 'partition' as EdgeKind,
      })
      .select('id')
      .maybeSingle();
  }
  return {
    id: insertNode.id,
    label: insertNode.label,
    parentId: insertNode.parent_id,
    projectId,
  };
}

// ---------------------------------------------------------------------------
// update_concept  (write)
// ---------------------------------------------------------------------------

export const updateConceptInput = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    partitionAttribute: z.string().optional(),
    rationale: z.string().optional(),
    status: z.enum(['open', 'validated', 'archived']).optional(),
  })
  .strict();

export async function updateConcept(
  client: SupabaseClient,
  args: z.infer<typeof updateConceptInput>,
) {
  const patch: Partial<NodeRow> = {};
  if (args.label !== undefined) patch.label = args.label;
  if (args.description !== undefined) patch.description = args.description;
  if (args.tags !== undefined) patch.tags = args.tags;
  if (args.partitionAttribute !== undefined)
    patch.partition_attribute = args.partitionAttribute;
  if (args.rationale !== undefined) patch.rationale = args.rationale;
  if (args.status !== undefined) patch.status = args.status;
  if (Object.keys(patch).length === 0) {
    return { error: 'No fields to update.' };
  }
  const row = unwrap(
    await client
      .from('nodes')
      .update(patch)
      .eq('id', args.id)
      .select('id, label, status')
      .maybeSingle(),
  ) as { id: string; label: string; status: NodeStatus } | null;
  if (!row) return { error: `No concept with id ${args.id}` };
  return { id: row.id, label: row.label, status: row.status };
}

// ---------------------------------------------------------------------------
// link_concepts  (write — k-ref / derived-from / semantic-adjacency only)
// ---------------------------------------------------------------------------
// We DON'T expose `partition` here — partition edges are an artifact of
// parent_id and are managed via add_concept / set_parent. Matches the
// webapp tool's contract.

export const linkConceptsInput = z
  .object({
    fromId: z.string().min(1),
    toId: z.string().min(1),
    kind: z.enum(['k-ref', 'derived-from', 'semantic-adjacency']),
  })
  .strict();

export async function linkConcepts(
  client: SupabaseClient,
  args: z.infer<typeof linkConceptsInput>,
) {
  if (args.fromId === args.toId) {
    return { error: 'Self-loop edges are not allowed.' };
  }
  // These are .maybeSingle() lookups whose null result is MEANINGFUL ("not
  // found" / "no duplicate") — do NOT wrap them in unwrap(). unwrap() throws on
  // a null `data`, so the dup-check below blew up with "Empty result from
  // cloud" on EVERY first-time link, meaning no non-partition edge (derived-
  // from / k-ref / semantic-adjacency, incl. add_kref) could ever be created.
  const fromRes = await client
    .from('nodes')
    .select('id, workspace_id')
    .eq('id', args.fromId)
    .maybeSingle();
  if (fromRes.error) throw new Error(fromRes.error.message);
  const from = fromRes.data as { id: string; workspace_id: string } | null;
  if (!from) return { error: `No concept with id ${args.fromId}` };
  const toRes = await client
    .from('nodes')
    .select('id, workspace_id')
    .eq('id', args.toId)
    .maybeSingle();
  if (toRes.error) throw new Error(toRes.error.message);
  const to = toRes.data as { id: string; workspace_id: string } | null;
  if (!to) return { error: `No concept with id ${args.toId}` };
  if (from.workspace_id !== to.workspace_id) {
    return {
      error: 'Cannot link concepts from different workspaces.',
    };
  }
  // Reject duplicate edges of the same kind on the same pair. A null here is
  // the normal "no existing edge" case — handle it directly, never unwrap().
  const dupRes = await client
    .from('edges')
    .select('id')
    .eq('from_id', from.id)
    .eq('to_id', to.id)
    .eq('kind', args.kind)
    .maybeSingle();
  if (dupRes.error) throw new Error(dupRes.error.message);
  const dup = dupRes.data as { id: string } | null;
  if (dup) {
    return { id: dup.id, fromId: from.id, toId: to.id, kind: args.kind, duplicate: true };
  }
  const row = unwrap(
    await client
      .from('edges')
      .insert({
        workspace_id: from.workspace_id,
        from_id: from.id,
        to_id: to.id,
        kind: args.kind,
      })
      .select('id, from_id, to_id, kind')
      .single(),
  ) as Pick<EdgeRow, 'id' | 'from_id' | 'to_id' | 'kind'>;
  return { id: row.id, fromId: row.from_id, toId: row.to_id, kind: row.kind };
}

// ---------------------------------------------------------------------------
// Provenance helper (Phase 19.4)
// ---------------------------------------------------------------------------
// Every write tool stamps a provenance row tagged origin='mcp'. The insert is
// best-effort: if the row can't land (e.g. RLS denies, table missing because
// migration 0015 isn't applied yet, etc.) the underlying write has already
// succeeded — surfacing a provenance failure as a tool error would be more
// confusing than helpful. The note is logged to stderr instead.

interface StampArgs {
  nodeId: string;
  workspaceId: string;
  sourceRef: string;            // short verb tag e.g. 'add', 'update', 'archive'
  origin?: ProvenanceOriginCloud; // defaults to 'mcp'
  operatorKey?: string;
  llmJson?: Record<string, unknown> | null;
  analysisId?: string;
  analysisTool?: string;
}

async function stampProvenance(
  client: SupabaseClient,
  args: StampArgs,
): Promise<void> {
  try {
    // Tag the originating device so the webapp timeline can show WHICH MCP
    // device made the change. Rides in source_refs as `device:<name>` — no
    // schema migration, and source_refs already syncs/exports.
    const device = getActiveDeviceName();
    const row = {
      workspace_id: args.workspaceId,
      node_id: args.nodeId,
      origin: args.origin ?? 'mcp',
      operator_key: args.operatorKey ?? null,
      source_refs: device ? [args.sourceRef, `device:${device}`] : [args.sourceRef],
      llm_json: args.llmJson ?? null,
      created_by: 'agent' as const,
      analysis_id: args.analysisId ?? null,
      analysis_tool: args.analysisTool ?? null,
      timestamp_ms: Date.now(),
    };
    const res = await client.from('provenance').insert(row as never);
    if (res.error) {
      console.error(
        `[heuresis-mcp] provenance insert failed (best-effort): ${res.error.message}`,
      );
    }
  } catch (err) {
    console.error(
      `[heuresis-mcp] provenance insert threw (best-effort): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ===========================================================================
// READS — additions (Phase 19.4)
// ===========================================================================

// ---------------------------------------------------------------------------
// get_workspace_summary
// ---------------------------------------------------------------------------
// Same shape the legacy snapshot mode produced so existing agent prompts
// keep working. Source of truth is the cloud workspace, not a snapshot file.

export const getWorkspaceSummaryInput = z.object({}).strict();

export async function getWorkspaceSummary(client: SupabaseClient) {
  const wsId = await resolveWorkspaceId(client);
  const ws = unwrap(
    await client
      .from('workspaces')
      .select('id, name')
      .eq('id', wsId)
      .maybeSingle(),
  ) as { id: string; name: string } | null;
  const [projectRows, ideaRows, nodeCountRes, edgeCountRes] = await Promise.all([
    client.from('projects').select('*').eq('workspace_id', wsId),
    client.from('ideas').select('*').eq('workspace_id', wsId),
    client
      .from('nodes')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsId),
    client
      .from('edges')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsId),
  ]);
  const projects = unwrap(projectRows) as ProjectRow[];
  const ideas = unwrap(ideaRows) as IdeaRow[];
  if (nodeCountRes.error) throw new Error(nodeCountRes.error.message);
  if (edgeCountRes.error) throw new Error(edgeCountRes.error.message);
  // Per-project membership counts.
  const pn = unwrap(
    await client
      .from('project_nodes')
      .select('project_id, node_id')
      .in('project_id', projects.map((p) => p.id)),
  ) as Pick<ProjectNodeRow, 'project_id' | 'node_id'>[];
  const projCount = new Map<string, number>();
  for (const r of pn) projCount.set(r.project_id, (projCount.get(r.project_id) ?? 0) + 1);
  // Per-idea membership counts.
  const inJ = unwrap(
    await client
      .from('idea_nodes')
      .select('idea_id, node_id')
      .in('idea_id', ideas.map((i) => i.id)),
  ) as Pick<IdeaNodeRow, 'idea_id' | 'node_id'>[];
  const ideaCount = new Map<string, number>();
  for (const r of inJ) ideaCount.set(r.idea_id, (ideaCount.get(r.idea_id) ?? 0) + 1);
  return {
    workspaceId: wsId,
    workspaces: ws ? [{ id: ws.id, name: ws.name }] : [],
    counts: {
      nodes: nodeCountRes.count ?? 0,
      edges: edgeCountRes.count ?? 0,
      projects: projects.length,
      ideas: ideas.length,
    },
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      brief: p.brief,
      direction: p.direction,
      lifecycle: p.lifecycle,
      nodeCount: projCount.get(p.id) ?? 0,
      rootNodeId: p.root_node_id,
    })),
    ideas: ideas.map((i) => ({
      id: i.id,
      name: i.name,
      color: i.color,
      nodeCount: ideaCount.get(i.id) ?? 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// list_recent_decisions
// ---------------------------------------------------------------------------
// "Decisions" = nodes the user has explicitly resolved recently (validated,
// starred, or archived). Same shape as the legacy snapshot tool.

export const listRecentDecisionsInput = z
  .object({
    sinceMs: z
      .number()
      .int()
      .optional()
      .describe('Unix-ms cutoff; default = last 7 days.'),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(20),
  })
  .strict();

export async function listRecentDecisions(
  client: SupabaseClient,
  args: z.infer<typeof listRecentDecisionsInput>,
) {
  const wsId = await resolveWorkspaceId(client);
  const cutoff = args.sinceMs ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoff).toISOString();
  // Fetch the most-recently-updated nodes that match a decision shape.
  const rows = unwrap(
    await client
      .from('nodes')
      .select('id, label, status, starred, updated_at')
      .eq('workspace_id', wsId)
      .gte('updated_at', cutoffIso)
      .order('updated_at', { ascending: false })
      .limit(args.limit * 4),
  ) as Pick<NodeRow, 'id' | 'label' | 'status' | 'starred' | 'updated_at'>[];
  const decisions = rows
    .filter((n) => n.starred || n.status === 'validated' || n.status === 'archived')
    .slice(0, args.limit)
    .map((n) => ({
      id: n.id,
      label: n.label,
      status: n.status,
      starred: n.starred,
      updatedAt: n.updated_at,
      decision:
        n.status === 'validated'
          ? 'validated'
          : n.status === 'archived'
            ? 'archived'
            : n.starred
              ? 'starred'
              : 'open',
    }));
  return {
    sinceMs: cutoff,
    since: cutoffIso,
    count: decisions.length,
    decisions,
  };
}

// ---------------------------------------------------------------------------
// list_concepts
// ---------------------------------------------------------------------------
// Mirrors webapp `list_concepts`. `scope`='project' uses projectId arg (the
// MCP has no notion of a "current project" the way the webapp does), so the
// MCP arg adds projectId where the webapp implicitly reads currentProjectId.

export const listConceptsInput = z
  .object({
    scope: z.enum(['project', 'workspace']).default('workspace'),
    projectId: z
      .string()
      .optional()
      .describe('Required when scope=project.'),
    includeArchived: z.boolean().default(false),
    detail: detailArg,
    limit: z.number().int().min(1).max(500).default(500),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Skip this many results — page through a large workspace with limit + offset.'),
  })
  .strict();

export async function listConcepts(
  client: SupabaseClient,
  args: z.infer<typeof listConceptsInput>,
) {
  const wsId = await resolveWorkspaceId(client);
  let memberIds: string[] | null = null;
  let projectName: string | null = null;
  if (args.scope === 'project') {
    if (!args.projectId) {
      return { error: 'scope=project requires projectId.' };
    }
    const proj = unwrapMaybe(
      await client
        .from('projects')
        .select('id, name')
        .eq('id', args.projectId)
        .maybeSingle(),
    ) as { id: string; name: string } | null;
    if (!proj) return { error: `No project with id ${args.projectId}` };
    projectName = proj.name;
    const rows = unwrap(
      await client
        .from('project_nodes')
        .select('node_id')
        .eq('project_id', args.projectId),
    ) as { node_id: string }[];
    memberIds = rows.map((r) => r.node_id);
    if (memberIds.length === 0) {
      return {
        scope: args.scope,
        projectName,
        total: 0,
        truncated: false,
        concepts: [],
      };
    }
  }
  let qb = client
    .from('nodes')
    .select('*', { count: 'exact' })
    .eq('workspace_id', wsId)
    .order('updated_at', { ascending: false })
    .range(args.offset, args.offset + args.limit - 1);
  if (memberIds) qb = qb.in('id', memberIds);
  if (!args.includeArchived) qb = qb.neq('status', 'archived');
  const res = await qb;
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data ?? []) as NodeRow[];
  const total = res.count ?? rows.length;
  return {
    scope: args.scope,
    projectName,
    total,
    offset: args.offset,
    returned: rows.length,
    hasMore: args.offset + rows.length < total,
    concepts: rows.map((n) => nodeView(n, args.detail)),
  };
}

// ---------------------------------------------------------------------------
// list_edges
// ---------------------------------------------------------------------------
// Mirrors webapp `list_edges`. Restrict to a project when projectId is given.

export const listEdgesInput = z
  .object({
    projectId: z.string().optional(),
    kind: z
      .enum(['partition', 'k-ref', 'semantic-adjacency', 'derived-from', 'imported-from'])
      .optional(),
  })
  .strict();

export async function listEdges(
  client: SupabaseClient,
  args: z.infer<typeof listEdgesInput>,
) {
  const wsId = await resolveWorkspaceId(client);
  let memberIds: Set<string> | null = null;
  if (args.projectId) {
    const rows = unwrap(
      await client
        .from('project_nodes')
        .select('node_id')
        .eq('project_id', args.projectId),
    ) as { node_id: string }[];
    memberIds = new Set(rows.map((r) => r.node_id));
    if (memberIds.size === 0) {
      return { total: 0, edges: [] as { id: string; fromId: string; toId: string; kind: EdgeKind }[] };
    }
  }
  let qb = client
    .from('edges')
    .select('id, from_id, to_id, kind')
    .eq('workspace_id', wsId);
  if (args.kind) qb = qb.eq('kind', args.kind);
  const rows = unwrap(await qb) as Pick<EdgeRow, 'id' | 'from_id' | 'to_id' | 'kind'>[];
  const filtered = memberIds
    ? rows.filter((e) => memberIds!.has(e.from_id) && memberIds!.has(e.to_id))
    : rows;
  return {
    total: filtered.length,
    edges: filtered.map((e) => ({
      id: e.id,
      fromId: e.from_id,
      toId: e.to_id,
      kind: e.kind,
    })),
  };
}

// ---------------------------------------------------------------------------
// find_concepts
// ---------------------------------------------------------------------------
// Mirrors the webapp `find_concepts` tool, label/substring path only. The
// webapp's by='meaning' variant relies on in-browser embeddings; that path is
// not wired on the MCP side, so this tool accepts by='label' only.

export const findConceptsInput = z
  .object({
    query: z.string().min(1),
    k: z.number().int().positive().max(20).default(10),
    by: z.enum(['label']).default('label'),
    projectId: z.string().optional(),
  })
  .strict();

export async function findConcepts(
  client: SupabaseClient,
  args: z.infer<typeof findConceptsInput>,
) {
  // We just call searchConcepts; the shape is similar but the response
  // contract here matches the webapp tool's response (`hits`, `mode`).
  const sub = await searchConcepts(client, {
    query: args.query,
    limit: args.k,
    detail: 'compact',
    projectId: args.projectId,
  } as z.infer<typeof searchConceptsInput>);
  if ('error' in sub) return sub;
  type ResultRow = { id: string; label: string; status: NodeStatus };
  const results = ((sub as { results: ResultRow[] }).results ?? []) as ResultRow[];
  const hits = results.map((r) => ({
    id: r.id,
    label: r.label,
    status: r.status,
    score: 1,
  }));
  return { hits, mode: 'label' };
}

// ===========================================================================
// WRITES — additions (Phase 19.4)
// ===========================================================================

// ---------------------------------------------------------------------------
// validate_concept
// ---------------------------------------------------------------------------

export const validateConceptInput = z
  .object({
    id: z.string().min(1),
    rationale: z.string().optional(),
  })
  .strict();

export async function validateConcept(
  client: SupabaseClient,
  args: z.infer<typeof validateConceptInput>,
) {
  const node = unwrapMaybe(
    await client.from('nodes').select('*').eq('id', args.id).maybeSingle(),
  ) as NodeRow | null;
  if (!node) return { error: `No concept with id ${args.id}` };
  const patch: Partial<NodeRow> = { status: 'validated' };
  if (args.rationale !== undefined) patch.rationale = args.rationale;
  const row = unwrapMaybe(
    await client
      .from('nodes')
      .update(patch as never)
      .eq('id', args.id)
      .select('id, label, status')
      .maybeSingle(),
  ) as { id: string; label: string; status: NodeStatus } | null;
  if (!row) return { error: `Update failed for ${args.id}` };
  await stampProvenance(client, {
    nodeId: row.id,
    workspaceId: node.workspace_id,
    sourceRef: 'validate',
  });
  return { id: row.id, label: row.label, status: row.status };
}

// ---------------------------------------------------------------------------
// set_standing
// ---------------------------------------------------------------------------

export const setStandingInput = z
  .object({
    id: z.string().min(1),
    standing: z.enum(['unknown', 'novel', 'emerging', 'established']),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export async function setStanding(
  client: SupabaseClient,
  args: z.infer<typeof setStandingInput>,
) {
  const node = unwrapMaybe(
    await client
      .from('nodes')
      .select('id, workspace_id, label, standing_rationale')
      .eq('id', args.id)
      .maybeSingle(),
  ) as Pick<NodeRow, 'id' | 'workspace_id' | 'label' | 'standing_rationale'> | null;
  if (!node) return { error: `No concept with id ${args.id}` };
  const patch: Partial<NodeRow> = {
    standing: args.standing as ConceptStanding,
    standing_rationale: args.rationale,
    standing_assessed_at: new Date().toISOString(),
  };
  const row = unwrapMaybe(
    await client
      .from('nodes')
      .update(patch as never)
      .eq('id', args.id)
      .select('id, label, standing, standing_rationale')
      .maybeSingle(),
  ) as Pick<NodeRow, 'id' | 'label' | 'standing' | 'standing_rationale'> | null;
  if (!row) return { error: `Update failed for ${args.id}` };
  await stampProvenance(client, {
    nodeId: row.id,
    workspaceId: node.workspace_id,
    sourceRef: `standing:${args.standing}`,
  });
  return {
    id: row.id,
    label: row.label,
    standing: row.standing,
    rationale: row.standing_rationale,
  };
}

// ---------------------------------------------------------------------------
// archive_concept / unarchive_concept / star_concept
// ---------------------------------------------------------------------------

export const archiveConceptInput = z.object({ id: z.string().min(1) }).strict();

export async function archiveConcept(
  client: SupabaseClient,
  args: z.infer<typeof archiveConceptInput>,
) {
  const node = unwrapMaybe(
    await client
      .from('nodes')
      .select('id, workspace_id, label, status')
      .eq('id', args.id)
      .maybeSingle(),
  ) as Pick<NodeRow, 'id' | 'workspace_id' | 'label' | 'status'> | null;
  if (!node) return { error: `No concept with id ${args.id}` };
  if (node.status === 'archived') {
    return { id: node.id, label: node.label, status: node.status, noop: true };
  }
  const row = unwrapMaybe(
    await client
      .from('nodes')
      .update({ status: 'archived' } as never)
      .eq('id', args.id)
      .select('id, label, status')
      .maybeSingle(),
  ) as { id: string; label: string; status: NodeStatus } | null;
  if (!row) return { error: `Update failed for ${args.id}` };
  await stampProvenance(client, {
    nodeId: row.id,
    workspaceId: node.workspace_id,
    sourceRef: 'archive',
  });
  return { id: row.id, label: row.label, status: row.status };
}

export const unarchiveConceptInput = z.object({ id: z.string().min(1) }).strict();

export async function unarchiveConcept(
  client: SupabaseClient,
  args: z.infer<typeof unarchiveConceptInput>,
) {
  const node = unwrapMaybe(
    await client
      .from('nodes')
      .select('id, workspace_id, label, status')
      .eq('id', args.id)
      .maybeSingle(),
  ) as Pick<NodeRow, 'id' | 'workspace_id' | 'label' | 'status'> | null;
  if (!node) return { error: `No concept with id ${args.id}` };
  if (node.status !== 'archived') {
    return { id: node.id, label: node.label, status: node.status, noop: true };
  }
  const row = unwrapMaybe(
    await client
      .from('nodes')
      .update({ status: 'open' } as never)
      .eq('id', args.id)
      .select('id, label, status')
      .maybeSingle(),
  ) as { id: string; label: string; status: NodeStatus } | null;
  if (!row) return { error: `Update failed for ${args.id}` };
  await stampProvenance(client, {
    nodeId: row.id,
    workspaceId: node.workspace_id,
    sourceRef: 'unarchive',
  });
  return { id: row.id, label: row.label, status: row.status };
}

export const starConceptInput = z.object({ id: z.string().min(1) }).strict();

export async function starConcept(
  client: SupabaseClient,
  args: z.infer<typeof starConceptInput>,
) {
  const node = unwrapMaybe(
    await client
      .from('nodes')
      .select('id, workspace_id, label, starred')
      .eq('id', args.id)
      .maybeSingle(),
  ) as Pick<NodeRow, 'id' | 'workspace_id' | 'label' | 'starred'> | null;
  if (!node) return { error: `No concept with id ${args.id}` };
  const next = !node.starred;
  const row = unwrapMaybe(
    await client
      .from('nodes')
      .update({ starred: next } as never)
      .eq('id', args.id)
      .select('id, label, starred')
      .maybeSingle(),
  ) as { id: string; label: string; starred: boolean } | null;
  if (!row) return { error: `Update failed for ${args.id}` };
  await stampProvenance(client, {
    nodeId: row.id,
    workspaceId: node.workspace_id,
    sourceRef: next ? 'star' : 'unstar',
  });
  return { id: row.id, label: row.label, starred: row.starred };
}

// ---------------------------------------------------------------------------
// remove_concept (cascade across the parent_id tree)
// ---------------------------------------------------------------------------
// Cloud FKs:
//   nodes.parent_id   ON DELETE SET NULL (children become orphans, NOT auto-
//                                          deleted by Postgres)
//   edges.from_id/to_id ON DELETE CASCADE
//   project_nodes / idea_nodes ON DELETE CASCADE
// So to match the webapp's `removeNode` cascade we walk the parent_id graph
// in code, collect every descendant, and delete the bottom-up set.

export const removeConceptInput = z.object({ id: z.string().min(1) }).strict();

export async function removeConcept(
  client: SupabaseClient,
  args: z.infer<typeof removeConceptInput>,
) {
  const node = unwrapMaybe(
    await client
      .from('nodes')
      .select('id, workspace_id, label')
      .eq('id', args.id)
      .maybeSingle(),
  ) as Pick<NodeRow, 'id' | 'workspace_id' | 'label'> | null;
  if (!node) return { error: `No concept with id ${args.id}` };
  // Refuse to delete a project's root.
  const isRoot = unwrap(
    await client
      .from('projects')
      .select('id')
      .eq('root_node_id', args.id)
      .limit(1),
  ) as { id: string }[];
  if (isRoot.length > 0) {
    return { error: 'Cannot delete a project root node.' };
  }
  // Walk the subtree via BOTH parent_id AND partition edges. A child can be
  // attached either way; walking parent_id alone would strand partition-only
  // children as dangling orphans (the inconsistency surfaced in the rc.17
  // review — get_subtree counts partition-edge children, so the cascade must
  // too).
  const allNodes = unwrap(
    await client.from('nodes').select('id, parent_id').eq('workspace_id', node.workspace_id),
  ) as Pick<NodeRow, 'id' | 'parent_id'>[];
  const partEdges = unwrap(
    await client
      .from('edges')
      .select('from_id, to_id')
      .eq('workspace_id', node.workspace_id)
      .eq('kind', 'partition'),
  ) as { from_id: string; to_id: string }[];
  const childrenByParent = new Map<string, string[]>();
  const addChild = (parent: string, child: string) => {
    const arr = childrenByParent.get(parent) ?? [];
    arr.push(child);
    childrenByParent.set(parent, arr);
  };
  for (const n of allNodes) if (n.parent_id) addChild(n.parent_id, n.id);
  for (const e of partEdges) addChild(e.from_id, e.to_id);
  const toDelete: string[] = [];
  const seen = new Set<string>();
  const stack = [args.id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    toDelete.push(cur);
    for (const k of childrenByParent.get(cur) ?? []) if (!seen.has(k)) stack.push(k);
  }
  // Delete in one shot — edges/junctions cascade via FK; provenance
  // cascades via FK in 0015's table definition.
  const del = await client.from('nodes').delete().in('id', toDelete);
  if (del.error) return { error: del.error.message };
  return {
    id: args.id,
    removed: true,
    cascadeCount: toDelete.length,
  };
}

// ---------------------------------------------------------------------------
// remove_concepts (bulk) — delete many concepts in one call.
// ---------------------------------------------------------------------------
// Sequential (not parallel) so a big cleanup can't hammer the backend; each id
// reuses removeConcept (so each cascades its own subtree). Per-id results are
// returned so the caller sees exactly what landed — ids already gone (e.g.
// swept up in another id's cascade) come back ok:false with a not-found error,
// which is expected, not fatal.

export const removeConceptsInput = z
  .object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(500)
      .describe('Concept ids to hard-delete. Each cascades its own subtree.'),
  })
  .strict();

export async function removeConcepts(
  client: SupabaseClient,
  args: z.infer<typeof removeConceptsInput>,
) {
  const results: { id: string; ok: boolean; cascadeCount?: number; error?: string }[] = [];
  for (const id of args.ids) {
    const r = (await removeConcept(client, { id })) as {
      removed?: boolean;
      cascadeCount?: number;
      error?: string;
    };
    if (r.error) results.push({ id, ok: false, error: r.error });
    else results.push({ id, ok: true, cascadeCount: r.cascadeCount });
  }
  const ok = results.filter((r) => r.ok).length;
  return {
    requested: args.ids.length,
    deleted: ok,
    failed: args.ids.length - ok,
    results,
  };
}

// ---------------------------------------------------------------------------
// bulk_add_concepts (atomic via fn_bulk_add_concepts RPC)
// ---------------------------------------------------------------------------
// Each child resolves its project_id either explicitly (via the item's
// `projectId`), via the parent's home project, or via the workspace's only
// project. Resolution happens here (the RPC requires project_id on every
// item) and the RPC then guarantees atomicity across the multi-row insert.

export const bulkAddConceptsInput = z
  .object({
    items: z
      .array(
        z.object({
          label: z.string().min(1).max(140),
          description: z.string().max(2000).optional(),
          parentId: z.string().nullable().optional(),
          projectId: z.string().optional(),
          tags: z.array(z.string()).optional(),
        }),
      )
      .min(1)
      .max(200),
  })
  .strict();

export async function bulkAddConcepts(
  client: SupabaseClient,
  args: z.infer<typeof bulkAddConceptsInput>,
) {
  const wsId = await resolveWorkspaceId(client);
  // Pre-resolve every item's project_id so the RPC has the simple shape.
  const parentIds = Array.from(
    new Set(
      args.items
        .map((i) => i.parentId)
        .filter((p): p is string => typeof p === 'string' && p.length > 0),
    ),
  );
  const parentRows = parentIds.length
    ? (unwrap(
        await client.from('nodes').select('id, project_id').in('id', parentIds),
      ) as Pick<NodeRow, 'id' | 'project_id'>[])
    : [];
  const parentProject = new Map(parentRows.map((p) => [p.id, p.project_id]));
  // Workspace's solo project, used when nothing else resolves.
  const projectRows = unwrap(
    await client.from('projects').select('id').eq('workspace_id', wsId),
  ) as { id: string }[];
  const soloProjectId = projectRows.length === 1 ? projectRows[0].id : null;
  const resolved: {
    parent_id: string | null;
    label: string;
    description: string;
    tags: string[];
    project_id: string;
  }[] = [];
  for (const item of args.items) {
    let projectId = item.projectId ?? null;
    if (!projectId && item.parentId) {
      projectId = parentProject.get(item.parentId) ?? null;
    }
    if (!projectId) projectId = soloProjectId;
    if (!projectId) {
      return {
        error: `Could not resolve projectId for item "${item.label}" — workspace has ${projectRows.length} projects, no parent to inherit from.`,
      };
    }
    resolved.push({
      parent_id: item.parentId ?? null,
      label: item.label,
      description: item.description ?? '',
      tags: item.tags ?? [],
      project_id: projectId,
    });
  }
  const rpc = await client.rpc('fn_bulk_add_concepts' as never, {
    p_items: resolved as unknown,
  } as never);
  if (rpc.error) return { error: rpc.error.message };
  const created = (rpc.data ?? []) as {
    id: string;
    label: string;
    parent_id: string | null;
    project_id: string;
  }[];
  // Best-effort provenance for each new node.
  for (const c of created) {
    await stampProvenance(client, {
      nodeId: c.id,
      workspaceId: wsId,
      sourceRef: 'bulk-add',
    });
  }
  return {
    created: created.map((c) => ({
      id: c.id,
      label: c.label,
      parentId: c.parent_id,
      projectId: c.project_id,
    })),
    count: created.length,
  };
}

// ---------------------------------------------------------------------------
// set_parent (move a node + sync partition edge)
// ---------------------------------------------------------------------------
// Mirrors webapp `set_parent` / store.moveNodeParent: updates parent_id AND
// drops any pre-existing partition edge whose target is this node, then
// inserts a fresh partition edge from the new parent if non-null.

export const setParentInput = z
  .object({
    nodeId: z.string().min(1),
    newParentId: z.string().nullable(),
  })
  .strict();

export async function setParent(
  client: SupabaseClient,
  args: z.infer<typeof setParentInput>,
) {
  const node = unwrapMaybe(
    await client
      .from('nodes')
      .select('id, workspace_id, parent_id, label')
      .eq('id', args.nodeId)
      .maybeSingle(),
  ) as Pick<NodeRow, 'id' | 'workspace_id' | 'parent_id' | 'label'> | null;
  if (!node) return { error: `No concept with id ${args.nodeId}` };
  if (args.newParentId && args.newParentId === args.nodeId) {
    return { error: 'Cannot parent a node to itself.' };
  }
  let resolvedParentId: string | null = args.newParentId;
  if (resolvedParentId) {
    const parent = unwrapMaybe(
      await client
        .from('nodes')
        .select('id, workspace_id')
        .eq('id', resolvedParentId)
        .maybeSingle(),
    ) as { id: string; workspace_id: string } | null;
    if (!parent) return { error: `New parent ${resolvedParentId} not found.` };
    if (parent.workspace_id !== node.workspace_id) {
      return { error: 'Cannot re-parent across workspaces.' };
    }
    // Cycle guard: the new parent must not sit inside this node's own subtree —
    // that would detach the subtree from any root and break parent-chain
    // traversal (get_subtree / get_concept ancestry / remove_concept cascade).
    const wsNodes = unwrap(
      await client.from('nodes').select('id, parent_id').eq('workspace_id', node.workspace_id),
    ) as Pick<NodeRow, 'id' | 'parent_id'>[];
    const parentOf = new Map(wsNodes.map((n) => [n.id, n.parent_id]));
    let walk: string | null = resolvedParentId;
    const visited = new Set<string>();
    while (walk && !visited.has(walk)) {
      if (walk === args.nodeId) {
        return {
          error:
            "Cannot set parent: the target parent is inside this node's own subtree (would create a cycle).",
        };
      }
      visited.add(walk);
      walk = parentOf.get(walk) ?? null;
    }
  }
  // 1) Update parent_id.
  const updRes = await client
    .from('nodes')
    .update({ parent_id: resolvedParentId } as never)
    .eq('id', args.nodeId);
  if (updRes.error) return { error: updRes.error.message };
  // 2) Delete every existing partition edge whose target is this node.
  const delRes = await client
    .from('edges')
    .delete()
    .eq('to_id', args.nodeId)
    .eq('kind', 'partition');
  if (delRes.error) return { error: delRes.error.message };
  // 3) Insert a fresh partition edge from the new parent (if any).
  if (resolvedParentId) {
    const insRes = await client.from('edges').insert({
      workspace_id: node.workspace_id,
      from_id: resolvedParentId,
      to_id: args.nodeId,
      kind: 'partition' as EdgeKind,
    } as never);
    if (insRes.error) return { error: insRes.error.message };
  }
  await stampProvenance(client, {
    nodeId: args.nodeId,
    workspaceId: node.workspace_id,
    sourceRef: 'set-parent',
  });
  return {
    ok: true,
    nodeId: args.nodeId,
    newParentId: resolvedParentId,
  };
}

// ---------------------------------------------------------------------------
// add_kref — convenience alias of link_concepts kind='k-ref'.
// ---------------------------------------------------------------------------

export const addKrefInput = z
  .object({
    fromId: z.string().min(1),
    toId: z.string().min(1),
  })
  .strict();

export async function addKref(
  client: SupabaseClient,
  args: z.infer<typeof addKrefInput>,
) {
  return linkConcepts(client, {
    fromId: args.fromId,
    toId: args.toId,
    kind: 'k-ref',
  });
}

// ---------------------------------------------------------------------------
// IDEAS — create_idea, rename_idea, recolor_idea, set_idea_members,
//         add_to_idea, delete_idea
// ---------------------------------------------------------------------------
// Idea ↔ node membership lives in `idea_nodes`. `set_idea_members` follows
// the reconcileJunctionForParent pattern from src/data/cloud-sync.ts: upsert
// the desired pairs, then delete the rows no longer in the set.

const DEFAULT_IDEA_PALETTE = [
  '#ff6b6b',
  '#ffd166',
  '#06d6a0',
  '#118ab2',
  '#9b5de5',
  '#f15bb5',
  '#00bbf9',
  '#fee440',
];

export const createIdeaInput = z
  .object({
    name: z.string().min(1).max(140),
    color: z.string().optional(),
    nodeIds: z.array(z.string()).optional(),
  })
  .strict();

export async function createIdea(
  client: SupabaseClient,
  args: z.infer<typeof createIdeaInput>,
) {
  const wsId = await resolveWorkspaceId(client);
  // Pick a default color if none given. Webapp uses an 8-color palette
  // indexed by current idea count; do the same here.
  let color = args.color;
  if (!color) {
    const existing = unwrap(
      await client
        .from('ideas')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', wsId),
    );
    void existing;
    // The head:true query returns count via the result envelope; we just
    // index modulo palette length using a fresh count query.
    const c = await client
      .from('ideas')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsId);
    color = DEFAULT_IDEA_PALETTE[(c.count ?? 0) % DEFAULT_IDEA_PALETTE.length];
  }
  const idea = unwrap(
    await client
      .from('ideas')
      .insert({ workspace_id: wsId, name: args.name, color } as never)
      .select('id, name, color')
      .single(),
  ) as Pick<IdeaRow, 'id' | 'name' | 'color'>;
  // Insert membership rows.
  const nodeIds = args.nodeIds ?? [];
  if (nodeIds.length > 0) {
    const rows = nodeIds.map((nid, i) => ({
      idea_id: idea.id,
      node_id: nid,
      position: i,
    }));
    const ins = await client.from('idea_nodes').insert(rows as never);
    if (ins.error) return { error: ins.error.message };
  }
  return { id: idea.id, name: idea.name, color: idea.color, nodeCount: nodeIds.length };
}

export const renameIdeaInput = z
  .object({ id: z.string().min(1), name: z.string().min(1).max(140) })
  .strict();

export async function renameIdea(
  client: SupabaseClient,
  args: z.infer<typeof renameIdeaInput>,
) {
  const row = unwrap(
    await client
      .from('ideas')
      .update({ name: args.name } as never)
      .eq('id', args.id)
      .select('id, name')
      .maybeSingle(),
  ) as { id: string; name: string } | null;
  if (!row) return { error: `No idea with id ${args.id}` };
  return { id: row.id, name: row.name };
}

export const recolorIdeaInput = z
  .object({ id: z.string().min(1), color: z.string().min(1) })
  .strict();

export async function recolorIdea(
  client: SupabaseClient,
  args: z.infer<typeof recolorIdeaInput>,
) {
  const row = unwrap(
    await client
      .from('ideas')
      .update({ color: args.color } as never)
      .eq('id', args.id)
      .select('id, name, color')
      .maybeSingle(),
  ) as Pick<IdeaRow, 'id' | 'name' | 'color'> | null;
  if (!row) return { error: `No idea with id ${args.id}` };
  return { id: row.id, name: row.name, color: row.color };
}

export const setIdeaMembersInput = z
  .object({
    ideaId: z.string().min(1),
    nodeIds: z.array(z.string()),
  })
  .strict();

export async function setIdeaMembers(
  client: SupabaseClient,
  args: z.infer<typeof setIdeaMembersInput>,
) {
  const idea = unwrap(
    await client
      .from('ideas')
      .select('id, name')
      .eq('id', args.ideaId)
      .maybeSingle(),
  ) as { id: string; name: string } | null;
  if (!idea) return { error: `No idea with id ${args.ideaId}` };
  const desiredOrder = new Map<string, number>(
    args.nodeIds.map((n, i) => [n, i] as const),
  );
  const existing = unwrap(
    await client
      .from('idea_nodes')
      .select('node_id')
      .eq('idea_id', args.ideaId),
  ) as { node_id: string }[];
  const existingSet = new Set(existing.map((r) => r.node_id));
  // Upsert desired rows.
  const upserts = [...desiredOrder.entries()].map(([nid, position]) => ({
    idea_id: args.ideaId,
    node_id: nid,
    position,
  }));
  if (upserts.length > 0) {
    const up = await client
      .from('idea_nodes')
      .upsert(upserts as never, { onConflict: 'idea_id,node_id' });
    if (up.error) return { error: up.error.message };
  }
  // Delete rows not in the desired set.
  const toRemove = [...existingSet].filter((nid) => !desiredOrder.has(nid));
  if (toRemove.length > 0) {
    const del = await client
      .from('idea_nodes')
      .delete()
      .eq('idea_id', args.ideaId)
      .in('node_id', toRemove);
    if (del.error) return { error: del.error.message };
  }
  return {
    id: args.ideaId,
    name: idea.name,
    nodeCount: desiredOrder.size,
    added: [...desiredOrder.keys()].filter((n) => !existingSet.has(n)).length,
    removed: toRemove.length,
  };
}

export const addToIdeaInput = z
  .object({
    ideaId: z.string().min(1),
    nodeId: z.string().min(1),
  })
  .strict();

export async function addToIdea(
  client: SupabaseClient,
  args: z.infer<typeof addToIdeaInput>,
) {
  const idea = unwrap(
    await client
      .from('ideas')
      .select('id')
      .eq('id', args.ideaId)
      .maybeSingle(),
  ) as { id: string } | null;
  if (!idea) return { error: `No idea with id ${args.ideaId}` };
  const node = unwrap(
    await client
      .from('nodes')
      .select('id')
      .eq('id', args.nodeId)
      .maybeSingle(),
  ) as { id: string } | null;
  if (!node) return { error: `No concept with id ${args.nodeId}` };
  const ins = await client
    .from('idea_nodes')
    .upsert(
      { idea_id: args.ideaId, node_id: args.nodeId, position: 0 } as never,
      { onConflict: 'idea_id,node_id' },
    );
  if (ins.error) return { error: ins.error.message };
  return { ideaId: args.ideaId, nodeId: args.nodeId };
}

export const deleteIdeaInput = z.object({ id: z.string().min(1) }).strict();

export async function deleteIdea(
  client: SupabaseClient,
  args: z.infer<typeof deleteIdeaInput>,
) {
  const del = await client.from('ideas').delete().eq('id', args.id);
  if (del.error) return { error: del.error.message };
  return { id: args.id, deleted: true };
}

// ---------------------------------------------------------------------------
// PROJECTS — create_project, update_project, delete_project
// ---------------------------------------------------------------------------

export const createProjectInput = z
  .object({
    name: z.string().min(1).max(140),
    brief: z.string().max(2000).default(''),
    direction: z.string().max(2000).optional(),
  })
  .strict();

export async function createProject(
  client: SupabaseClient,
  args: z.infer<typeof createProjectInput>,
) {
  const wsId = await resolveWorkspaceId(client);
  const row = unwrap(
    await client
      .from('projects')
      .insert({
        workspace_id: wsId,
        name: args.name,
        brief: args.brief,
        direction: args.direction ?? null,
      } as never)
      .select('id, name, brief, direction, lifecycle')
      .single(),
  ) as Pick<ProjectRow, 'id' | 'name' | 'brief' | 'direction' | 'lifecycle'>;
  return {
    id: row.id,
    name: row.name,
    brief: row.brief,
    direction: row.direction,
    lifecycle: row.lifecycle,
  };
}

export const updateProjectInput = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(140).optional(),
    brief: z.string().max(2000).optional(),
    direction: z.string().max(2000).optional(),
    lifecycle: z.enum(['active', 'paused', 'completed', 'abandoned']).optional(),
  })
  .strict();

export async function updateProject(
  client: SupabaseClient,
  args: z.infer<typeof updateProjectInput>,
) {
  const patch: Partial<ProjectRow> = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.brief !== undefined) patch.brief = args.brief;
  if (args.direction !== undefined) patch.direction = args.direction;
  if (args.lifecycle !== undefined) patch.lifecycle = args.lifecycle;
  if (Object.keys(patch).length === 0) {
    return { error: 'No fields to update.' };
  }
  const row = unwrap(
    await client
      .from('projects')
      .update(patch as never)
      .eq('id', args.id)
      .select('id, name, brief, direction, lifecycle')
      .maybeSingle(),
  ) as Pick<ProjectRow, 'id' | 'name' | 'brief' | 'direction' | 'lifecycle'> | null;
  if (!row) return { error: `No project with id ${args.id}` };
  return {
    id: row.id,
    name: row.name,
    brief: row.brief,
    direction: row.direction,
    lifecycle: row.lifecycle,
  };
}

export const deleteProjectInput = z
  .object({
    id: z.string().min(1),
    deleteNodes: z
      .boolean()
      .default(false)
      .describe(
        "Also hard-delete every concept in this project (each cascades its subtree). Default false leaves the nodes behind as orphans — matching prior behavior. Use true to avoid creating orphans.",
      ),
  })
  .strict();

export async function deleteProject(
  client: SupabaseClient,
  args: z.infer<typeof deleteProjectInput>,
) {
  if (args.deleteNodes) {
    // Capture members BEFORE deleting the project (project_nodes cascades away
    // with it). Delete the project first so removeConcept's "can't delete a
    // project root" guard no longer blocks the root node.
    const members = unwrap(
      await client.from('project_nodes').select('node_id').eq('project_id', args.id),
    ) as { node_id: string }[];
    const del = await client.from('projects').delete().eq('id', args.id);
    if (del.error) return { error: del.error.message };
    let nodesDeleted = 0;
    for (const m of members) {
      const r = (await removeConcept(client, { id: m.node_id })) as {
        cascadeCount?: number;
        error?: string;
      };
      // Many members are already gone (swept up in the root's cascade); that
      // returns a not-found error we simply skip.
      if (!r.error && typeof r.cascadeCount === 'number') nodesDeleted += r.cascadeCount;
    }
    return { id: args.id, deleted: true, nodesDeleted };
  }
  const del = await client.from('projects').delete().eq('id', args.id);
  if (del.error) return { error: del.error.message };
  return { id: args.id, deleted: true };
}

// ---------------------------------------------------------------------------
// find_orphans — surface concepts that no normal traversal reaches.
// ---------------------------------------------------------------------------
// Two integrity classes, both confined to the caller's own workspace (RLS):
//   • projectless  — node in no project (the classic residue of delete_project,
//                    which leaves nodes behind).
//   • danglingParent — node whose parent_id points at a row that no longer
//                    exists (invisible to root traversal, yet still present).
// Read-only; pair with remove_concepts (to delete) or set_parent (to re-home).

export const findOrphansInput = z
  .object({
    kind: z
      .enum(['projectless', 'dangling', 'all'])
      .default('all')
      .describe("Which orphan class to surface: 'projectless', 'dangling', or 'all'."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(200)
      .describe('Max nodes to list per class (counts are always exact).'),
  })
  .strict();

export async function findOrphans(
  client: SupabaseClient,
  args: z.infer<typeof findOrphansInput>,
) {
  const wsId = await resolveWorkspaceId(client);
  const allNodes = unwrap(
    await client.from('nodes').select('id, label, parent_id, status').eq('workspace_id', wsId),
  ) as Pick<NodeRow, 'id' | 'label' | 'parent_id' | 'status'>[];
  const liveIds = new Set(allNodes.map((n) => n.id));
  const projects = unwrap(
    await client.from('projects').select('id').eq('workspace_id', wsId),
  ) as { id: string }[];
  let memberIds = new Set<string>();
  if (projects.length > 0) {
    const pn = unwrap(
      await client
        .from('project_nodes')
        .select('node_id')
        .in(
          'project_id',
          projects.map((p) => p.id),
        ),
    ) as { node_id: string }[];
    memberIds = new Set(pn.map((r) => r.node_id));
  }
  const view = (n: Pick<NodeRow, 'id' | 'label' | 'parent_id' | 'status'>) => ({
    id: n.id,
    label: n.label,
    parentId: n.parent_id,
    status: n.status,
  });
  const result: Record<string, unknown> = { workspaceId: wsId, totalNodes: allNodes.length };
  if (args.kind === 'projectless' || args.kind === 'all') {
    const projectless = allNodes.filter((n) => !memberIds.has(n.id));
    result.projectless = {
      count: projectless.length,
      nodes: projectless.slice(0, args.limit).map(view),
    };
  }
  if (args.kind === 'dangling' || args.kind === 'all') {
    const dangling = allNodes.filter((n) => n.parent_id && !liveIds.has(n.parent_id));
    result.danglingParent = {
      count: dangling.length,
      nodes: dangling.slice(0, args.limit).map(view),
    };
  }
  result.note =
    'projectless = in no project (often left by delete_project). danglingParent = parent_id points at a deleted node. To clean up: remove_concepts(ids) to delete, or set_parent to re-home.';
  return result;
}

// ---------------------------------------------------------------------------
// CLOUD_TOOLS registry — index.ts imports this and wires it into MCP.
// ---------------------------------------------------------------------------
// Each entry: { name, description, inputSchema, handler(client, args) }. The
// handler signature is uniform so index.ts can drive every tool through one
// dispatch. Operator tools (Phase 19.5, Agent A) live in cloudOperators.ts
// and are wired the same way.

export interface CloudToolDef<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (client: SupabaseClient, args: TArgs) => Promise<TResult>;
}

export const CLOUD_TOOLS: CloudToolDef[] = [
  // ── Reads ──────────────────────────────────────────────────────────────
  {
    name: 'list_projects',
    description:
      'Every project in the workspace with brief, direction, lifecycle, and node count. Use this to figure out which project the user is asking about.',
    inputSchema: listProjectsInput,
    handler: async (client) => listProjects(client),
  },
  {
    name: 'get_project_graph',
    description:
      'Every node + edge inside one project. Returns a graph the agent can reason over end-to-end. Use for project-wide questions.',
    inputSchema: getProjectGraphInput,
    handler: async (client, args) =>
      getProjectGraph(client, getProjectGraphInput.parse(args)),
  },
  {
    name: 'get_subtree',
    description:
      'A node and its descendants up to a given depth. Pass the concept as `id` (or `rootId`). Use when the user asks "tell me about everything under X".',
    // ZodEffects (refine+transform for the id/rootId alias) — cast like the
    // operator tools; zodToJsonSchema unwraps it for the served schema.
    inputSchema: getSubtreeInput as unknown as z.ZodObject<z.ZodRawShape>,
    handler: async (client, args) => getSubtree(client, getSubtreeInput.parse(args)),
  },
  {
    name: 'get_concept',
    description:
      'One concept by id, optionally with its ancestry (parent chain), direct children, and idea memberships.',
    inputSchema: getConceptInput,
    handler: async (client, args) => getConcept(client, getConceptInput.parse(args)),
  },
  {
    name: 'search_concepts',
    description:
      "Substring search across concept labels, descriptions, partition attributes, rationale, and tags. Use this when the user mentions a concept by name and you don't have its id. (Semantic search is a Phase 19.5 enhancement.)",
    inputSchema: searchConceptsInput,
    handler: async (client, args) =>
      searchConcepts(client, searchConceptsInput.parse(args)),
  },
  {
    name: 'get_workspace_summary',
    description:
      "Counts of nodes / edges / projects / ideas + a one-line overview of each project and idea. Always start here when you don't know what's in the workspace.",
    inputSchema: getWorkspaceSummaryInput,
    handler: async (client) => getWorkspaceSummary(client),
  },
  {
    name: 'list_recent_decisions',
    description:
      'Nodes the user has explicitly resolved (validated, starred, or archived) recently. Use to surface "what did we conclude last week" without a full scan.',
    inputSchema: listRecentDecisionsInput,
    handler: async (client, args) =>
      listRecentDecisions(client, listRecentDecisionsInput.parse(args)),
  },
  {
    name: 'list_concepts',
    description:
      'List concepts in the workspace or one project. Returns id / label / status / parentId / tags up to `limit` entries (default 500). Use BEFORE making changes to learn what already exists.',
    inputSchema: listConceptsInput,
    handler: async (client, args) =>
      listConcepts(client, listConceptsInput.parse(args)),
  },
  {
    name: 'list_edges',
    description:
      'List every edge in the workspace (or restricted to a project). Filter by kind: partition / k-ref / semantic-adjacency / derived-from / imported-from.',
    inputSchema: listEdgesInput,
    handler: async (client, args) => listEdges(client, listEdgesInput.parse(args)),
  },
  {
    name: 'find_concepts',
    description:
      'Find concepts by label/substring match. Returns up to k hits, each with id, label, status.',
    inputSchema: findConceptsInput,
    handler: async (client, args) =>
      findConcepts(client, findConceptsInput.parse(args)),
  },

  // ── Writes ─────────────────────────────────────────────────────────────
  {
    name: 'add_concept',
    description:
      'Create a new concept (Node). If parentId is given, the concept becomes a CHILD of that concept and a partition edge is auto-created. If parentId is omitted, the concept attaches to the project root.',
    inputSchema: addConceptInput,
    handler: async (client, args) => addConcept(client, addConceptInput.parse(args)),
  },
  {
    name: 'update_concept',
    description:
      "Update an existing concept's label, description, tags, partitionAttribute, rationale, or status. Only the fields provided are changed.",
    inputSchema: updateConceptInput,
    handler: async (client, args) =>
      updateConcept(client, updateConceptInput.parse(args)),
  },
  {
    name: 'link_concepts',
    description:
      "Create an edge between two concepts. kind is one of: 'k-ref' (knowledge reference), 'derived-from' (provenance link), 'semantic-adjacency' (sibling kinship). Partition (parent/child) edges are managed via add_concept / set_parent.",
    inputSchema: linkConceptsInput,
    handler: async (client, args) =>
      linkConcepts(client, linkConceptsInput.parse(args)),
  },
  {
    name: 'add_kref',
    description:
      'Convenience: create a k-ref (knowledge reference) edge from fromId → toId. Equivalent to link_concepts with kind=k-ref.',
    inputSchema: addKrefInput,
    handler: async (client, args) => addKref(client, addKrefInput.parse(args)),
  },
  {
    name: 'validate_concept',
    description:
      'Mark a concept as validated (status=validated). Optionally also overwrite `rationale`. Idempotent on already-validated nodes.',
    inputSchema: validateConceptInput,
    handler: async (client, args) =>
      validateConcept(client, validateConceptInput.parse(args)),
  },
  {
    name: 'set_standing',
    description:
      "Set a concept's STANDING — how known / proven the idea is in the wider world. `standing` ∈ 'novel' | 'emerging' | 'established' | 'unknown'. `rationale` is a one-sentence justification (saved as `standing_rationale`). Use this when classifying / judging novelty.",
    inputSchema: setStandingInput,
    handler: async (client, args) =>
      setStanding(client, setStandingInput.parse(args)),
  },
  {
    name: 'archive_concept',
    description: 'Archive a concept (status=archived). Reversible via unarchive_concept.',
    inputSchema: archiveConceptInput,
    handler: async (client, args) =>
      archiveConcept(client, archiveConceptInput.parse(args)),
  },
  {
    name: 'unarchive_concept',
    description: 'Revive a previously-archived concept (status=open). Idempotent on already-open nodes.',
    inputSchema: unarchiveConceptInput,
    handler: async (client, args) =>
      unarchiveConcept(client, unarchiveConceptInput.parse(args)),
  },
  {
    name: 'star_concept',
    description: 'Toggle the starred flag on a concept (user-favorite marker).',
    inputSchema: starConceptInput,
    handler: async (client, args) =>
      starConcept(client, starConceptInput.parse(args)),
  },
  {
    name: 'remove_concept',
    description:
      'Hard-delete a concept and its descendants (walks the subtree via parent_id AND partition edges). Edges and project/idea memberships cascade via FK. Refuses to delete a project root node. For many at once, use remove_concepts.',
    inputSchema: removeConceptInput,
    handler: async (client, args) =>
      removeConcept(client, removeConceptInput.parse(args)),
  },
  {
    name: 'remove_concepts',
    description:
      "Bulk hard-delete: delete many concepts in one call (each cascades its own subtree). Returns per-id results. Ids already swept up in another id's cascade come back ok:false (not-found) — expected, not fatal. Pair with find_orphans for cleanup.",
    inputSchema: removeConceptsInput,
    handler: async (client, args) =>
      removeConcepts(client, removeConceptsInput.parse(args)),
  },
  {
    name: 'find_orphans',
    description:
      "Surface concepts no normal traversal reaches, scoped to your workspace: 'projectless' (in no project — typically left behind by delete_project) and 'danglingParent' (parent_id points at a deleted node). Read-only. Clean up with remove_concepts (delete) or set_parent (re-home).",
    inputSchema: findOrphansInput,
    handler: async (client, args) =>
      findOrphans(client, findOrphansInput.parse(args)),
  },
  {
    name: 'bulk_add_concepts',
    description:
      'Create many concepts in a single atomic transaction. `items` is an array; each item carries label / description? / parentId? / projectId? / tags?. project_id is resolved per-item (explicit > inherited from parent > workspace solo project). Returns the created ids in input order.',
    inputSchema: bulkAddConceptsInput,
    handler: async (client, args) =>
      bulkAddConcepts(client, bulkAddConceptsInput.parse(args)),
  },
  {
    name: 'set_parent',
    description:
      "Re-parent an existing concept: nodeId's parent becomes newParentId (or detached when null). Updates BOTH node.parent_id AND the partition edge so the canvas tree stays in sync.",
    inputSchema: setParentInput,
    handler: async (client, args) =>
      setParent(client, setParentInput.parse(args)),
  },

  // Ideas
  {
    name: 'create_idea',
    description:
      'Create a new Idea (a named grouping of concepts) with an optional color and optional starting node membership.',
    inputSchema: createIdeaInput,
    handler: async (client, args) =>
      createIdea(client, createIdeaInput.parse(args)),
  },
  {
    name: 'rename_idea',
    description: "Rename an Idea.",
    inputSchema: renameIdeaInput,
    handler: async (client, args) =>
      renameIdea(client, renameIdeaInput.parse(args)),
  },
  {
    name: 'recolor_idea',
    description: "Change an Idea's color (any CSS color string).",
    inputSchema: recolorIdeaInput,
    handler: async (client, args) =>
      recolorIdea(client, recolorIdeaInput.parse(args)),
  },
  {
    name: 'set_idea_members',
    description:
      "Replace an Idea's full membership with `nodeIds`. Reconciles the junction table: inserts missing pairs, deletes pairs no longer in the set. Returns added / removed counts.",
    inputSchema: setIdeaMembersInput,
    handler: async (client, args) =>
      setIdeaMembers(client, setIdeaMembersInput.parse(args)),
  },
  {
    name: 'add_to_idea',
    description: 'Add a single concept to an existing Idea (idempotent).',
    inputSchema: addToIdeaInput,
    handler: async (client, args) =>
      addToIdea(client, addToIdeaInput.parse(args)),
  },
  {
    name: 'delete_idea',
    description: 'Delete an Idea. Membership rows cascade via FK; the underlying concepts are untouched.',
    inputSchema: deleteIdeaInput,
    handler: async (client, args) =>
      deleteIdea(client, deleteIdeaInput.parse(args)),
  },

  // Projects
  {
    name: 'create_project',
    description: 'Create a new Project (problem-with-direction) with a name and brief. Optional `direction`.',
    inputSchema: createProjectInput,
    handler: async (client, args) =>
      createProject(client, createProjectInput.parse(args)),
  },
  {
    name: 'update_project',
    description:
      "Update a project's name / brief / direction / lifecycle. Only fields provided are changed.",
    inputSchema: updateProjectInput,
    handler: async (client, args) =>
      updateProject(client, updateProjectInput.parse(args)),
  },
  {
    name: 'delete_project',
    description:
      'Delete a project. By default its concepts are LEFT behind as orphans (find them later with find_orphans). Pass deleteNodes:true to also hard-delete every concept in the project (each cascades its subtree) so no orphans are created.',
    inputSchema: deleteProjectInput,
    handler: async (client, args) =>
      deleteProject(client, deleteProjectInput.parse(args)),
  },
];

// Used for the unused-import sanity check.
export type _UnusedIdeaNodeRow = IdeaNodeRow;
