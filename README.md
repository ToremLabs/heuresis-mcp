# @heuresis/mcp

A Model Context Protocol (MCP) server that exposes a Heuresis workspace
to any MCP-capable client (Claude Desktop, Claude Code, Cursor,
Windsurf, custom agents). The server logs into the user's Heuresis
account, talks to the same Supabase project the webapp talks to, and
respects the same RLS. Webapp and MCP are two front-ends to one cloud
workspace.

Current version: `1.0.0-rc.13`.

## Install

```bash
npm install -g @heuresis/mcp
# or on demand without installing:
npx -y @heuresis/mcp
```

> **Package name vs. command name.** The npm package is `@heuresis/mcp`; the
> command it installs is `heuresis-mcp`. A bare `npx -y @heuresis/mcp` (no
> subcommand) starts the MCP server fine, but `npx @heuresis/mcp login` can
> fail with `heuresis-mcp: not found` because npx derives the command name
> from the scope-stripped package name (`mcp`), which doesn't match. To run a
> subcommand reliably on every npm/OS, name the binary explicitly with `-p`:
>
> ```bash
> npx -y -p @heuresis/mcp heuresis-mcp login
> ```

## Quickstart

### 1. Link this machine to your Heuresis account

```bash
npx -y -p @heuresis/mcp heuresis-mcp login
```

The CLI prints a device code and a one-click URL of the form
`https://heuresis.app/device?code=XXXX-XXXX`. Open it in your browser,
sign in if you aren't already, and confirm the device. The CLI polls
in the background and writes credentials to
`~/.heuresis/credentials.json` (chmod 600 on POSIX) the moment you
confirm. Subsequent runs of the MCP are silent.

The login flow rides three Supabase Edge Functions:
`mcp-device-init`, `mcp-device-grant`, and `mcp-device-poll`.

To unlink a machine: `npx -y -p @heuresis/mcp heuresis-mcp logout`, or open
Settings ▸ Connected devices in the webapp to revoke remotely.

`npx -y -p @heuresis/mcp heuresis-mcp whoami` confirms which account a machine
is currently linked to.

### 2. Point your MCP client at it

**Claude Desktop.** Edit
`~/Library/Application Support/Claude/claude_desktop_config.json` on
macOS, or `%APPDATA%/Claude/claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "heuresis": { "command": "npx", "args": ["-y", "@heuresis/mcp"] }
  }
}
```

**Claude Code / Cursor / Windsurf.** Drop a `.mcp.json` in the
workspace root:

```json
{
  "mcpServers": {
    "heuresis": { "command": "npx", "args": ["-y", "@heuresis/mcp"] }
  }
}
```

Restart the client. The Heuresis tools appear in the tool menu.

### 3. CLI subcommands

```bash
npx -y -p @heuresis/mcp heuresis-mcp whoami   # show the linked account + device
npx -y -p @heuresis/mcp heuresis-mcp logout   # delete the credentials file
npx -y -p @heuresis/mcp heuresis-mcp --help   # all options
npx -y @heuresis/mcp --no-realtime            # boot the server with live sync off (persisted)
npx -y @heuresis/mcp --realtime               # re-enable live sync
```

## Headless mode (CI, cloud agents, disposable containers)

Device pairing writes a **refresh token** to disk. That works great on a
personal machine, but it does **not** survive disposable/ephemeral
environments (CI runners, cloud agent containers, "Claude Code on the web"):
the filesystem is wiped between runs, and a Supabase refresh token is
**single-use under rotation** — so a token baked into config dies after the
first session.

For those environments, skip pairing and let the server **sign in fresh on
every boot** from your account email + password (a password is not consumed on
use, so it works forever with no re-pairing). Set three env vars:

```bash
HEURESIS_EMAIL=you@example.com          # your Heuresis account email
HEURESIS_PASSWORD=your-account-password # secret — store it in a secrets manager
HEURESIS_ANON_KEY=sb_publishable_...    # project anon/publishable key (public, not a secret)
# optional: HEURESIS_SUPABASE_URL=...   # defaults to the production project
```

When `HEURESIS_EMAIL` + `HEURESIS_PASSWORD` are present they take precedence
over any `credentials.json`, and the MCP server authenticates per boot — no
device link required. Requirements:

- Email + password sign-in must be enabled for the Supabase project, and the
  account must have a password set (passwordless / magic-link-only accounts
  need a password added first).
- Treat `HEURESIS_PASSWORD` as a secret. Prefer a dedicated account if your
  environment can only expose env vars that are visible to its users.

## Live sync

When the MCP boots in cloud mode it subscribes to the workspace over
Supabase Realtime and notifies the client whenever a `nodes`, `edges`,
`projects`, or `ideas` row changes. Edits made in the webapp show up
in the agent's view without a manual refresh, and writes from one
MCP-connected client reach any other connected client the same way.
Pass `--no-realtime` to disable the subscription (useful if the
chatter is noisy or the client logs every notification). The
preference is saved to `~/.heuresis/config.json` so the flag only
needs to be passed once.

## Tools

34 tools total: 31 data tools against the cloud workspace, plus 3
operator tools that drive the same ideation operators the webapp uses.

**Reads (10).** `get_workspace_summary`, `list_projects`,
`get_project_graph`, `list_concepts`, `list_edges`, `get_subtree`,
`get_concept`, `search_concepts`, `find_concepts`,
`list_recent_decisions`. Most agent sessions start with
`get_workspace_summary` or `list_projects`.

**Writes (21).** Concepts: `add_concept`, `update_concept`,
`bulk_add_concepts`, `set_parent`, `validate_concept`, `set_standing`,
`archive_concept`, `unarchive_concept`, `star_concept`,
`remove_concept`. Edges: `link_concepts`, `add_kref`. Ideas:
`create_idea`, `rename_idea`, `recolor_idea`, `set_idea_members`,
`add_to_idea`, `delete_idea`. Projects: `create_project`,
`update_project`, `delete_project`. Every write stamps a row in
`public.provenance` with `origin='mcp'` so the webapp's session log
shows which surface made the change.

**Operator runs (3).** `run_operator` (generate candidates with
Branch / Matrix / ASIT / TRIZ / Combine / Free / Contradiction),
`run_operator_and_commit` (same, plus commit the result in one
round-trip), and `expand_concept` (recursive Branch, capped at depth ×
breadth ≤ 60).

Tool input shapes mirror their counterparts in the webapp's
`src/agent/tools.ts`, so an agent that uses both surfaces sees a
uniform contract.

Wave-shipping: `find_in_files` (in-browser embedding search) is in the
webapp but not yet on the MCP.

## Legacy snapshot mode (deprecated)

The original read-only snapshot reader still works as a fallback while
users migrate to cloud auth. With no `~/.heuresis/credentials.json`
and the `HEURESIS_SNAPSHOT` env var set, the server reads a JSON
export from disk and exposes the original read-only tool set
(`get_workspace_summary`, `list_projects`, `search_concepts`,
`get_concept`, `get_subtree`, `get_project_graph`,
`list_recent_decisions`).

```bash
export HEURESIS_SNAPSHOT="/absolute/path/to/your-export.json"
npx @heuresis/mcp
```

This path is deprecated and will be removed in a later release. It is
here so existing setups keep working through the migration to cloud
auth.

## License

AGPL-3.0-or-later.
