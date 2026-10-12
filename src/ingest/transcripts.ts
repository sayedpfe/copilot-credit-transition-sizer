import type { TokenProvider } from '../auth/token.js';
import { odataGetAll } from './dataverse.js';

const API = 'api/data/v9.2';

export interface AgentRef {
  botId: string;
  name: string;
  schemaName: string | null;
}

export interface TranscriptSession {
  id: string;
  startTime: string; // ISO
  botId: string | null;
}

/** Copilot Studio agents in the environment (Dataverse `bot` table). */
export async function fetchAgents(environmentUrl: string, token: string): Promise<AgentRef[]> {
  const rows = await odataGetAll(
    `${environmentUrl}/${API}/bots?$select=botid,name,schemaname`,
    token
  );
  return rows.map((r) => ({
    botId: String(r['botid']),
    name: (r['name'] as string | null) ?? '(unnamed agent)',
    schemaName: (r['schemaname'] as string | null) ?? null,
  }));
}

/**
 * Conversation sessions from the `conversationtranscript` table. Deliberately
 * selects ONLY id / start time / agent lookup — never the `content` column, so
 * no conversation text ever leaves the tenant boundary into the cache.
 *
 * The agent lookup column name has varied across schema versions; we try the
 * documented lookup first and fall back to an unattributed pull so the command
 * still yields session counts on tenants where the column differs.
 */
export async function fetchTranscriptSessions(
  environmentUrl: string,
  token: string,
  sinceIso: string,
  onPage?: (n: number) => void
): Promise<{ sessions: TranscriptSession[]; attributed: boolean }> {
  const base = `${environmentUrl}/${API}/conversationtranscripts`;
  const filter = `$filter=conversationstarttime ge ${sinceIso}`;
  try {
    const rows = await odataGetAll(
      `${base}?$select=conversationtranscriptid,conversationstarttime,_bot_conversationtranscriptid_value&${filter}`,
      token,
      onPage
    );
    return {
      attributed: true,
      sessions: rows.map((r) => ({
        id: String(r['conversationtranscriptid']),
        startTime: String(r['conversationstarttime'] ?? ''),
        botId: (r['_bot_conversationtranscriptid_value'] as string | null) ?? null,
      })),
    };
  } catch {
    // Fallback: no agent lookup column — session counts only.
    const rows = await odataGetAll(
      `${base}?$select=conversationtranscriptid,conversationstarttime&${filter}`,
      token,
      onPage
    );
    return {
      attributed: false,
      sessions: rows.map((r) => ({
        id: String(r['conversationtranscriptid']),
        startTime: String(r['conversationstarttime'] ?? ''),
        botId: null,
      })),
    };
  }
}
