#!/usr/bin/env node
// @heuresis/mcp — Heuresis Model Context Protocol server (v0.2.0-alpha).
//
// Two operating modes:
//
//   1. CLOUD (default, Phase 19.1+) — when ~/.heuresis/credentials.json
//      exists, every tool call hits Supabase against the user's session.
//      Same workspace the webapp sees, same RLS, live reads + writes.
//
//   2. LEGACY SNAPSHOT (deprecated, removed after 19.7) — when no
//      credentials are present AND $HEURESIS_SNAPSHOT is set, fall back
//      to the v0 read-only file-snapshot behavior. This keeps existing
//      installs working through the migration.
//
// Subcommands (one-shot, never start the MCP server):
//   login | logout | whoami | --help

import { existsSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from './zod-to-json-schema.js';
import { z } from 'zod';
import { HeuresisStore } from './store.js';
import {
  getConcept as legacyGetConcept,
  getConceptInput as legacyGetConceptInput,
  getProjectGraph as legacyGetProjectGraph,
  getProjectGraphInput as legacyGetProjectGraphInput,
  getSubtree as legacyGetSubtree,
  getSubtreeInput as legacyGetSubtreeInput,
  getWorkspaceSummary as legacyGetWorkspaceSummary,
  getWorkspaceSummaryInput as legacyGetWorkspaceSummaryInput,
  listProjects as legacyListProjects,
  listProjectsInput as legacyListProjectsInput,
  listRecentDecisions as legacyListRecentDecisions,
  listRecentDecisionsInput as legacyListRecentDecisionsInput,
  searchConcepts as legacySearchConcepts,
  searchConceptsInput as legacySearchConceptsInput,
} from './tools.js';
import { CLOUD_TOOLS, type CloudToolDef } from './cloudTools.js';
import { readCredentials } from './credentials.js';
import { CloudAuthError, getCloudClient } from './cloudClient.js';
import {
  helpCommand,
  loginCommand,
  logoutCommand,
  whoamiCommand,
} from './cli.js';
import {
  readRealtimeFlag,
  resolveSubscriptionWorkspaceId,
  startRealtimeSubscription,
  stripRealtimeFlags,
  type RealtimeChangeEvent,
} from './realtime.js';

const VERSION = '0.2.0-alpha';
const MAX_RESULT_CHARS = 50_000;

interface ToolDef<TInput> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: TInput) => Promise<unknown>;
}

function makeCloudTools(
  getClient: () => Promise<import('@supabase/supabase-js').SupabaseClient>,
  operatorTools: CloudToolDef[],
): ToolDef<unknown>[] {
  // Lazy: defer the actual auth handshake until the first tool call so the
  // MCP server boots fast.
  //
  // We compose two sources: CLOUD_TOOLS (Phase 19.4 data-layer parity) and
  // operatorTools (Phase 19.5 LLM-backed operators). Both share the
  // `CloudToolDef` shape; the only thing this layer adds is the lazy
  // `getClient()` hop so the handlers in cloudTools.ts can stay client-
  // agnostic.
  const merged: CloudToolDef[] = [...CLOUD_TOOLS, ...operatorTools];
  return merged.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    handler: async (args: unknown) => t.handler(await getClient(), args),
  }));
}

function makeLegacySnapshotTools(store: HeuresisStore): ToolDef<unknown>[] {
  // LEGACY FALLBACK — removed after 19.7. Read-only, no auth, snapshot file.
  return [
    {
      name: 'get_workspace_summary',
      description:
        "(Legacy snapshot mode) Counts of nodes/edges/projects/ideas + a one-line overview of each project and idea. Always start here when you don't know what's in the workspace.",
      inputSchema: legacyGetWorkspaceSummaryInput,
      handler: () => legacyGetWorkspaceSummary(store),
    },
    {
      name: 'list_projects',
      description:
        '(Legacy snapshot mode) Every project in the snapshot with brief, direction, lifecycle, and member count.',
      inputSchema: legacyListProjectsInput,
      handler: () => legacyListProjects(store),
    },
    {
      name: 'search_concepts',
      description:
        '(Legacy snapshot mode) Substring search across concept labels, descriptions, tags, and partition attributes.',
      inputSchema: legacySearchConceptsInput,
      handler: (args: unknown) => legacySearchConcepts(store, legacySearchConceptsInput.parse(args)),
    },
    {
      name: 'get_concept',
      description:
        '(Legacy snapshot mode) One concept by id, optionally with ancestry, children, and idea memberships.',
      inputSchema: legacyGetConceptInput,
      handler: (args: unknown) => legacyGetConcept(store, legacyGetConceptInput.parse(args)),
    },
    {
      name: 'get_subtree',
      description:
        '(Legacy snapshot mode) A node and its descendants up to a given depth.',
      inputSchema: legacyGetSubtreeInput,
      handler: (args: unknown) => legacyGetSubtree(store, legacyGetSubtreeInput.parse(args)),
    },
    {
      name: 'get_project_graph',
      description:
        '(Legacy snapshot mode) Every node + edge inside one project. Returns a graph the agent can reason over end-to-end.',
      inputSchema: legacyGetProjectGraphInput,
      handler: (args: unknown) =>
        legacyGetProjectGraph(store, legacyGetProjectGraphInput.parse(args)),
    },
    {
      name: 'list_recent_decisions',
      description:
        '(Legacy snapshot mode) Nodes the user has explicitly resolved (validated, starred, or archived) recently.',
      inputSchema: legacyListRecentDecisionsInput,
      handler: (args: unknown) =>
        legacyListRecentDecisions(store, legacyListRecentDecisionsInput.parse(args)),
    },
  ];
}

async function runServer(): Promise<void> {
  const creds = await readCredentials();
  const snapshotEnv = process.env.HEURESIS_SNAPSHOT;

  let tools: ToolDef<unknown>[];
  let modeBanner: string;

  if (creds) {
    // CLOUD mode.
    const getClient = async () => {
      try {
        const { client } = await getCloudClient(creds);
        return client;
      } catch (err) {
        if (err instanceof CloudAuthError) {
          throw new Error(err.message);
        }
        throw err;
      }
    };
    // Phase 19.5 — try to load Operator tools. The module may not exist
    // yet at build time (Agent A ships it in a parallel pass); if it's
    // missing OR exports nothing, we fall back to just the Phase 19.4
    // parity set. Wrapping the dynamic import in try/catch keeps the
    // server starting cleanly in either case.
    let operatorTools: CloudToolDef[] = [];
    try {
      const mod = (await import('./cloudOperators.js').catch(() => null)) as
        | { OPERATOR_TOOLS?: CloudToolDef[] }
        | null;
      if (mod && Array.isArray(mod.OPERATOR_TOOLS)) {
        operatorTools = mod.OPERATOR_TOOLS;
      }
    } catch {
      operatorTools = [];
    }
    tools = makeCloudTools(getClient, operatorTools);
    modeBanner = `cloud-authenticated (user_id ${creds.user_id}, device ${creds.device_name}; ${tools.length} tools)`;
  } else if (snapshotEnv || hasDefaultSnapshot()) {
    // LEGACY snapshot fallback.
    const store = new HeuresisStore();
    tools = makeLegacySnapshotTools(store);
    modeBanner = `legacy snapshot mode (path: ${store.getSnapshotPath()})`;
  } else {
    // Neither — print actionable error and exit.
    console.error(
      [
        '[heuresis-mcp] Not configured.',
        '',
        'To use cloud mode (recommended):',
        '  npx -y -p @heuresis/mcp heuresis-mcp login',
        '',
        'To use legacy snapshot mode (deprecated, removed after 19.7):',
        '  HEURESIS_SNAPSHOT=/path/to/export.json npx @heuresis/mcp',
        '',
        'See https://heuresis.app/mcp for setup details.',
      ].join('\n'),
    );
    process.exit(1);
  }

  // `resources` + `logging` are declared so the Realtime path (Phase 19.8) can
  // call `server.sendResourceListChanged()` / `sendLoggingMessage()` without
  // tripping the SDK's capability assertions. We don't expose any actual
  // resource handlers, but the notification surface is what the realtime
  // subscriber needs to ping the client when the workspace changes.
  const server = new Server(
    { name: '@heuresis/mcp', version: VERSION },
    { capabilities: { tools: {}, resources: { listChanged: true }, logging: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: `Unknown tool: ${req.params.name}` },
        ],
      };
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {});
      const text = JSON.stringify(result, null, 2);
      if (text.length > MAX_RESULT_CHARS) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text:
                `Result too large (${text.length} chars, limit ${MAX_RESULT_CHARS}). ` +
                `Narrow the query: lower 'limit'/'depth', keep detail='compact', ` +
                `or fetch individual nodes with get_concept.`,
            },
          ],
        };
      }
      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[heuresis-mcp ${VERSION}] ready - ${modeBanner}`);

  // Phase 19.8 - Supabase Realtime CDC subscription. Cloud mode only; legacy
  // snapshot mode has no live source to subscribe to.
  if (creds) {
    const realtimeOn = await readRealtimeFlag();
    if (!realtimeOn) {
      console.error('[heuresis-mcp] realtime: disabled (--no-realtime or config).');
    } else {
      // Don't block boot on the realtime handshake; fire-and-forget. If the
      // client (Supabase) is not reachable, the error surfaces on stderr.
      void (async () => {
        try {
          const { client } = await getCloudClient(creds);
          const wsId = await resolveSubscriptionWorkspaceId(client);
          if (!wsId) {
            console.error('[heuresis-mcp] realtime: no workspace visible; skipping subscription.');
            return;
          }
          startRealtimeSubscription(client, wsId, (event: RealtimeChangeEvent) => {
            if (event.eventType === 'RESYNC') {
              console.error('[heuresis-mcp] workspace resync: refetch any cached state.');
            } else if (event.table) {
              console.error(
                `[heuresis-mcp] workspace updated: ${event.table} ${event.eventType}`,
              );
            }
            // Best-effort MCP notification. Most clients will treat this as a
            // hint to refresh. We swallow errors because not every client
            // honors the resources capability.
            void server.sendResourceListChanged().catch(() => {
              /* client does not implement resource updates; stderr log is enough */
            });
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[heuresis-mcp] realtime: subscription failed: ${msg}`);
        }
      })();
    }
  }
}

function hasDefaultSnapshot(): boolean {
  try {
    const s = new HeuresisStore();
    // Only count the default path if it actually exists on disk; we never
    // want the default-path branch to trigger a "snapshot not found" error
    // when the user simply hasn't logged in yet.
    return existsSync(s.getSnapshotPath());
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // The Realtime flags (`--no-realtime` / `--realtime`) are consumed by the
  // realtime module via process.argv directly; strip them here so they don't
  // collide with subcommand dispatch when a user runs e.g.
  // `npx @heuresis/mcp --no-realtime`.
  const stripped = stripRealtimeFlags(process.argv.slice(2));
  const sub = stripped[0];
  switch (sub) {
    case undefined:
      await runServer();
      return;
    case 'login':
      await loginCommand(stripped.slice(1));
      return;
    case 'logout':
      await logoutCommand();
      return;
    case 'whoami':
      await whoamiCommand();
      return;
    case '-h':
    case '--help':
    case 'help':
      helpCommand();
      return;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      helpCommand();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error('[heuresis-mcp] fatal:', err);
  process.exit(1);
});
