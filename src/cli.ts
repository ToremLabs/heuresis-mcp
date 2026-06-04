// Heuresis MCP — CLI subcommand handlers.
//
// `npx @heuresis/mcp` with no subcommand → start the MCP stdio server
// (run by Claude Desktop / Claude Code / etc.). With a subcommand it's a
// one-shot CLI:
//   login    — pair this machine with the user's Heuresis account
//   logout   — delete ~/.heuresis/credentials.json
//   whoami   — print the linked email + workspace
//   --help   — usage
//
// AUTH UX (Phase 19.3 — device-code poll flow).
// ----------------------------------------------------------
// 1. POST to the `mcp-device-init` Edge Function with the chosen device name.
//    Receive a short XXXX-XXXX code + an expiry.
// 2. Tell the user to open https://heuresis.app/device (overridable via
//    HEURESIS_DEVICE_BASE_URL for staging / self-hosted setups) and enter
//    the code.
// 3. Poll `mcp-device-poll` every 5s until status: ok (claim accepted) or
//    410 (expired / already-used), or 15-minute timeout.
// 4. On success, write ~/.heuresis/credentials.json with the returned
//    refresh_token + supabase_url + anon_key + user_id + device_name and
//    print "Linked to <email>".
//
// The webapp `/device` page calls a third Edge Function `mcp-device-grant`
// to attach the user's identity to the pending grant row.

// Polyfill global WebSocket on Node < 22 before any Supabase client is built.
import './wsPolyfill.js';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  credentialsPath,
  defaultDeviceName,
  deleteCredentials,
  readCredentials,
  writeCredentials,
  type HeuresisCredentials,
} from './credentials.js';
import { exchangeRefreshToken, RefreshTokenError } from './gotrue.js';

// Where the device pairing UI lives. Production default; can be overridden
// for staging / self-hosted deploys via HEURESIS_DEVICE_BASE_URL. We also
// allow HEURESIS_SUPABASE_URL to override which Supabase project the CLI
// talks to (e.g. a staging instance). Both default to production.
const DEFAULT_DEVICE_BASE_URL = 'https://heuresis.app';
const DEFAULT_SUPABASE_URL = 'https://wpgniquyuppljeqkedqh.supabase.co';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1_000;

function log(...args: unknown[]): void {
  // Use stderr so we don't confuse MCP-client stdout parsers when this CLI
  // is misconfigured into the MCP slot. stderr is always safe.
  console.error(...args);
}

function printHelp(): void {
  log(
    [
      'heuresis-mcp — Heuresis MCP server (cloud-authenticated, alpha)',
      '',
      'Usage:',
      '  npx -y @heuresis/mcp                              Start the MCP stdio server (run by Claude Desktop, Cursor, etc.)',
      '  npx -y -p @heuresis/mcp heuresis-mcp login        Link this machine to your Heuresis account',
      '    --device-name <name>                             Override the default device name (hostname-shortRand).',
      '  npx -y -p @heuresis/mcp heuresis-mcp logout       Remove the saved credentials',
      '  npx -y -p @heuresis/mcp heuresis-mcp whoami       Show the linked account',
      '  npx -y -p @heuresis/mcp heuresis-mcp --help       Show this message',
      '',
      'Credentials are stored at:',
      `  ${credentialsPath()}`,
      '',
      'Environment overrides:',
      '  HEURESIS_DEVICE_BASE_URL   Webapp origin (default https://heuresis.app)',
      '  HEURESIS_SUPABASE_URL      Supabase project URL (default the heuresis.app project)',
      '',
      'Legacy snapshot mode (deprecated, removed after 19.7):',
      '  HEURESIS_SNAPSHOT=/path/to/export.json npx @heuresis/mcp',
      '  …falls back to read-only behavior against a JSON export.',
    ].join('\n'),
  );
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input, output, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

interface LoginOptions {
  deviceName?: string;
}

/** Parse `npx @heuresis/mcp login [--device-name <name>]`. */
function parseLoginFlags(argv: string[]): LoginOptions {
  const opts: LoginOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--device-name' || flag === '--device') {
      const v = argv[i + 1];
      if (!v) {
        log(`Missing value for ${flag}`);
        process.exit(2);
      }
      opts.deviceName = v;
      i++;
    } else {
      log(`Unknown flag: ${flag}`);
      process.exit(2);
    }
  }
  return opts;
}

/** Sleep `ms` milliseconds. Resolves only — no rejection path. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface InitResponse {
  code: string;
  expires_at: string;
}

interface PollSuccess {
  status: 'ok';
  refresh_token: string;
  user_id: string;
  supabase_url: string;
  anon_key: string;
  device_name: string;
}

interface PollPending {
  status: 'pending';
  expires_at: string;
}

// Wire HTTPS_PROXY / HTTP_PROXY env vars into Node's global fetch dispatcher.
// Node 18-22's undici does NOT auto-honor these vars (Node 24+ does). Without
// this, the CLI fails with "fetch failed" on corporate networks. Idempotent
// and a no-op when no proxy var is set.
let proxyAgentInstalled = false;
async function ensureProxyAgent(): Promise<void> {
  if (proxyAgentInstalled) return;
  proxyAgentInstalled = true;
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxyUrl) return;
  try {
    // Dynamic import keeps undici out of the cold-start path when no proxy
    // is in play. Node ships undici as part of the runtime so this resolves.
    const { ProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    log(`(routing through proxy ${proxyUrl})`);
  } catch (err) {
    log(`(could not configure proxy ${proxyUrl}: ${err instanceof Error ? err.message : String(err)})`);
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; data: unknown }> {
  await ensureProxyAgent();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* leave null */
  }
  return { status: res.status, data };
}

export async function loginCommand(argv: string[] = []): Promise<void> {
  const opts = parseLoginFlags(argv);
  const deviceName = opts.deviceName ?? defaultDeviceName();

  const deviceBaseUrl = process.env.HEURESIS_DEVICE_BASE_URL ?? DEFAULT_DEVICE_BASE_URL;
  const supabaseUrl = process.env.HEURESIS_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;

  log('');
  log('Heuresis MCP — device link (19.3)');
  log('─'.repeat(50));

  // 1. Init — allocate a pairing code.
  const initUrl = `${supabaseUrl}/functions/v1/mcp-device-init`;
  let initRes: { status: number; data: unknown };
  try {
    initRes = await postJson(initUrl, { device_name: deviceName });
  } catch (err) {
    log('');
    log(`Could not reach Heuresis at ${initUrl}.`);
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    log('If you are on a private / staging Supabase project, set HEURESIS_SUPABASE_URL.');
    process.exit(1);
  }
  if (initRes.status !== 200) {
    log('');
    log(`Failed to start the pairing flow (HTTP ${initRes.status}).`);
    const data = initRes.data as { error?: string; detail?: string } | null;
    if (data?.error) log(`  ${data.error}${data.detail ? ` — ${data.detail}` : ''}`);
    process.exit(1);
  }
  const init = initRes.data as InitResponse;
  if (!init?.code) {
    log('Pairing init returned no code. Aborting.');
    process.exit(1);
  }

  // 2. Tell the user where to go. The URL has the code baked in as a query
  // param so the device page can pre-fill it; the user just clicks Confirm.
  const confirmUrl = `${deviceBaseUrl}/device?code=${encodeURIComponent(init.code)}`;
  log('');
  log(`Open this URL to link this machine to your Heuresis account:`);
  log('');
  log(`  ${confirmUrl}`);
  log('');
  log(`(Code: ${init.code}, in case the page needs it manually. Expires in 15 min.)`);
  log('');
  log(`Waiting for confirmation…`);

  // 3. Poll until ok / 410 / timeout.
  const pollUrl = `${supabaseUrl}/functions/v1/mcp-device-poll`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let success: PollSuccess | null = null;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let pollRes: { status: number; data: unknown };
    try {
      pollRes = await postJson(pollUrl, { code: init.code });
    } catch (err) {
      // Transient network errors don't kill the loop — log once and keep polling.
      log(`  (network blip: ${err instanceof Error ? err.message : String(err)}; retrying)`);
      continue;
    }
    if (pollRes.status === 410) {
      log('');
      log('That code expired or was already used. Run `npx -y -p @heuresis/mcp heuresis-mcp login` again to start over.');
      process.exit(1);
    }
    if (pollRes.status === 202) {
      // Still pending — wait for the next tick.
      continue;
    }
    if (pollRes.status === 200) {
      const data = pollRes.data as PollSuccess | PollPending;
      if (data && (data as PollSuccess).status === 'ok') {
        success = data as PollSuccess;
        break;
      }
      // Unexpected 200 shape — keep trying until timeout rather than fail
      // catastrophically; the next poll will likely clarify.
      continue;
    }
    // Anything else: log and keep polling. The function may transiently 5xx.
    log(`  (poll returned HTTP ${pollRes.status}; retrying)`);
  }

  if (!success) {
    log('');
    log('Timed out waiting for confirmation. Run `npx -y -p @heuresis/mcp heuresis-mcp login` again.');
    process.exit(1);
  }

  // 4. Verify the refresh token works + fetch the user's email to print.
  // We exchange the refresh token straight against the GoTrue token endpoint
  // rather than going through supabase-js's stored-session machinery (which
  // throws "Auth session missing!" headlessly — see gotrue.ts for why).
  let email = '(no email on record)';
  try {
    const session = await exchangeRefreshToken(
      success.supabase_url,
      success.anon_key,
      success.refresh_token,
    );
    email = session.user?.email ?? email;
    // GoTrue rotates the refresh token on every exchange — persist the NEW
    // one so the credentials we write are immediately usable. The token we
    // got from the poll is now spent.
    success.refresh_token = session.refresh_token;
  } catch (err) {
    log('');
    if (err instanceof RefreshTokenError) {
      log(`Pairing returned a token, but it failed to refresh: ${err.message}`);
    } else {
      log(`Verification of the new refresh token failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    log('Run `npx -y -p @heuresis/mcp heuresis-mcp login` again to retry.');
    process.exit(1);
  }

  const creds: HeuresisCredentials = {
    supabase_url: success.supabase_url,
    anon_key: success.anon_key,
    refresh_token: success.refresh_token,
    user_id: success.user_id,
    device_name: success.device_name || deviceName,
    created_at: new Date().toISOString(),
  };
  const path = await writeCredentials(creds);

  log('');
  log(`Linked to ${email} as device "${creds.device_name}".`);
  log(`Credentials saved to ${path} (chmod 600 on POSIX).`);
  log('You can now point Claude Desktop / Claude Code at @heuresis/mcp.');
  log('');
}

export async function logoutCommand(): Promise<void> {
  const removed = await deleteCredentials();
  if (removed) {
    log('Heuresis credentials removed.');
  } else {
    log('No Heuresis credentials were found.');
  }
}

export async function whoamiCommand(): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    log('Not linked. Run `npx -y -p @heuresis/mcp heuresis-mcp login` to pair this machine.');
    process.exit(1);
  }
  log(`Heuresis MCP — linked`);
  log(`  device:        ${creds.device_name}`);
  log(`  user_id:       ${creds.user_id}`);
  log(`  supabase_url:  ${creds.supabase_url}`);
  log(`  created_at:    ${creds.created_at}`);
  log(`  credentials:   ${credentialsPath()}`);
}

export function helpCommand(): void {
  printHelp();
}

// The unused `prompt` helper would only be used if we re-introduced any
// interactive form; export it so future subcommands can pick it up without
// re-implementing readline plumbing.
export { prompt };
