// Credentials persistence at ~/.heuresis/credentials.json (chmod 600 on POSIX).
//
// The shape is intentionally small — supabase-js handles the access-token
// lifecycle from the refresh token, so all we ever need to write to disk is
// the refresh token and the project URL/anon key it pairs with.
//
// Format:
//   {
//     "supabase_url": "https://xyz.supabase.co",
//     "anon_key":     "ey...",
//     "refresh_token":"ey...",
//     "user_id":      "uuid",
//     "device_name":  "hostname-shortRandom",
//     "created_at":   "2026-05-21T..."
//   }
//
// Phase 19.3 will move refresh-token issuance behind the `mcp-device-grant`
// Edge Function and add a `refresh_token_id` column we record server-side.
// For now (19.1) the shape on disk matches what the user will paste from the
// browser link.

import { mkdir, readFile, writeFile, chmod, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface HeuresisCredentials {
  supabase_url: string;
  anon_key: string;
  refresh_token: string;
  user_id: string;
  device_name: string;
  created_at: string;
}

const isWindows = process.platform === 'win32';

export function credentialsPath(): string {
  return join(homedir(), '.heuresis', 'credentials.json');
}

export async function readCredentials(): Promise<HeuresisCredentials | null> {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    const text = await readFile(path, 'utf8');
    const data = JSON.parse(text) as Partial<HeuresisCredentials>;
    if (
      !data.supabase_url ||
      !data.anon_key ||
      !data.refresh_token ||
      !data.user_id ||
      !data.device_name ||
      !data.created_at
    ) {
      return null;
    }
    return data as HeuresisCredentials;
  } catch {
    return null;
  }
}

export async function writeCredentials(creds: HeuresisCredentials): Promise<string> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2), 'utf8');
  // chmod 600 — owner read/write only. No-op on Windows (NTFS perms are a
  // different model and the file lives in %USERPROFILE% which is already
  // user-private by default).
  if (!isWindows) {
    try {
      await chmod(path, 0o600);
    } catch {
      // best-effort; don't fail login just because of perm bits.
    }
  }
  return path;
}

export async function deleteCredentials(): Promise<boolean> {
  const path = credentialsPath();
  if (!existsSync(path)) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

export async function credentialsExist(): Promise<boolean> {
  const path = credentialsPath();
  if (!existsSync(path)) return false;
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Default device name = `${hostname}-${shortRandom}`. */
export function defaultDeviceName(): string {
  const host = hostname().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'device';
  const rand = randomBytes(3).toString('hex');
  return `${host}-${rand}`;
}
