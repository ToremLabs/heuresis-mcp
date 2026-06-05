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
import { CloudAuthError, getCloudClient, getCloudClientFromPassword } from './cloudClient.js';
import {
  DEFAULT_SUPABASE_URL,
  helpCommand,
  loginCommand,
  logoutCommand,
  whoamiCommand,
} from './cli.js';
import type { SupabaseClient } from '@supabase/supabase-js';
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

// Phase 19.5 — try to load LLM-backed Operator tools. The module may be absent
// or export nothing; in that case we fall back to just the Phase 19.4 parity
// set. Wrapping the dynamic import in try/catch keeps the server starting
// cleanly either way.
async function loadOperatorTools(): Promise<CloudToolDef[]> {
  try {
    const mod = (await import('./cloudOperators.js').catch(() => null)) as
      | { OPERATOR_TOOLS?: CloudToolDef[] }
      | null;
    if (mod && Array.isArray(mod.OPERATOR_TOOLS)) return mod.OPERATOR_TOOLS;
  } catch {
    /* fall through to empty */
  }
  return [];
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

  // Headless credential (durable across ephemeral/disposable sessions): when
  // HEURESIS_EMAIL + HEURESIS_PASSWORD are set, the server signs in fresh on
  // every boot. Unlike a persisted refresh token — which is single-use under
  // Supabase rotation and dies after one session — a password is not consumed,
  // so this survives container resets with zero re-pairing. It takes
  // precedence over a (possibly stale) credentials.json.
  const headlessEmail = process.env.HEURESIS_EMAIL?.trim();
  const headlessPassword = process.env.HEURESIS_PASSWORD;

  let tools: ToolDef<unknown>[];
  let modeBanner: string;
  // Single cloud client getter, shared by the tool handlers and the realtime
  // subscription. null in legacy snapshot / unconfigured modes.
  let cloudGetClient: (() => Promise<SupabaseClient>) | null = null;

  if (headlessEmail && headlessPassword) {
    // CLOUD mode — headless email/password sign-in (recommended for cloud /
    // disposable containers).
    const supabaseUrl = process.env.HEURESIS_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL;
    const anonKey = process.env.HEURESIS_ANON_KEY?.trim();
    if (!anonKey) {
      console.error(
        [
          '[heuresis-mcp] HEURESIS_EMAIL/HEURESIS_PASSWORD are set but HEURESIS_ANON_KEY is missing.',
          'Set HEURESIS_ANON_KEY to your project anon/publishable key (it is public, not a secret).',
        ].join('\n'),
      );
      process.exit(1);
    }
    cloudGetClient = async () => {
      try {
        const { client } = await getCloudClientFromPassword(
          supabaseUrl,
          anonKey,
          headlessEmail,
          headlessPassword,
        );
        return client;
      } catch (err) {
        if (err instanceof CloudAuthError) throw new Error(err.message);
        throw err;
      }
    };
    tools = makeCloudTools(cloudGetClient, await loadOperatorTools());
    modeBanner = `cloud-authenticated (headless ${headlessEmail}; ${tools.length} tools)`;
  } else if (creds) {
    // CLOUD mode — persisted device credential (refresh-token bootstrap).
    cloudGetClient = async () => {
      try {
        const { client } = await getCloudClient(creds);
        return client;
      } catch (err) {
        if (err instanceof CloudAuthError) throw new Error(err.message);
        throw err;
      }
    };
    tools = makeCloudTools(cloudGetClient, await loadOperatorTools());
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
        'To use cloud mode on a personal machine (device pairing):',
        '  npx -y -p @heuresis/mcp heuresis-mcp login',
        '',
        'To use cloud mode headlessly (CI / cloud agents / disposable containers),',
        'set these env vars so the server signs in fresh on every boot:',
        '  HEURESIS_EMAIL      your Heuresis account email',
        '  HEURESIS_PASSWORD   your Heuresis account password',
        '  HEURESIS_ANON_KEY   your project anon/publishable key (public, not a secret)',
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
  if (cloudGetClient) {
    const realtimeOn = await readRealtimeFlag();
    if (!realtimeOn) {
      console.error('[heuresis-mcp] realtime: disabled (--no-realtime or config).');
    } else {
      // Don't block boot on the realtime handshake; fire-and-forget. If the
      // client (Supabase) is not reachable, the error surfaces on stderr.
      void (async () => {
        try {
          const client = await cloudGetClient();
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
