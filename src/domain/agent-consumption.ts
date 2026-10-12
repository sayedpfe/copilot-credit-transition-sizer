import type { RatedEvent } from '../types.js';
import type { AgentRef, TranscriptSession } from '../ingest/transcripts.js';
import { monthKey } from './aggregate.js';

/**
 * Per-agent consumption view — the layered replacement for the retired
 * v0.1-alpha licensing endpoint. Three data classes, kept visibly distinct:
 *  - MEASURED sessions per agent (conversationtranscript, no content pulled)
 *  - MEASURED AI-tool Copilot Credits (msdyn_aievent MCS rows, re-rated)
 *  - ESTIMATED conversational credits — ONLY when the operator sets a rate in
 *    config (estimates are opt-in, never silent defaults)
 * Billing truth per agent remains PPAC → Licensing → Copilot Studio → Manage
 * Agents; this view is for trends, attribution, and reconciliation.
 */

export interface AgentMonthly {
  month: string;
  sessions: number;
  aiToolCC: number;
  estimatedConversationalCC: number | null;
}

export interface AgentConsumption {
  botId: string | null; // null => the unattributed bucket
  agentName: string;
  months: AgentMonthly[];
  totalSessions: number;
  totalAiToolCC: number;
  totalEstimatedCC: number | null;
}

export interface AgentConsumptionResult {
  environmentUrl: string;
  window: { from: string | null; to: string | null };
  agents: AgentConsumption[];
  transcriptsAttributed: boolean;
  mcsEventCount: number;
  mcsEventsWithAgentHint: number;
  creditsPerSessionEstimate: number | null;
  notes: string[];
}

const AGENT_HINT_KEYS = ['botid', 'bot_id', 'agentid', 'agent_id', 'botname', 'agentname'];

/** Try to pull an agent identifier out of the raw msdyn_eventdata JSON (MCS rows). */
export function extractAgentHint(eventData: string | null): string | null {
  if (!eventData || !eventData.trim()) return null;
  let root: unknown;
  try {
    root = JSON.parse(eventData);
  } catch {
    return null;
  }
  let found: string | null = null;
  const visit = (node: unknown, depth: number): void => {
    if (found || depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [rawKey, value] of Object.entries(node as Record<string, unknown>)) {
      const key = rawKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (AGENT_HINT_KEYS.includes(key) && typeof value === 'string' && value.trim()) {
        found = value.trim();
        return;
      }
      if (typeof value === 'object' && value !== null) visit(value, depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

export function buildAgentConsumption(
  environmentUrl: string,
  agents: AgentRef[],
  sessions: TranscriptSession[],
  transcriptsAttributed: boolean,
  mcsRatedEvents: RatedEvent[], // countable, MCS-source, already rated
  creditsPerSessionEstimate: number | null
): AgentConsumptionResult {
  const byAgent = new Map<string, { name: string; months: Map<string, AgentMonthly> }>();
  const UNATTRIBUTED = '(unattributed)';
  const nameOf = new Map(agents.map((a) => [a.botId.toLowerCase(), a.name]));

  const bucket = (botId: string | null, month: string): AgentMonthly => {
    const key = botId?.toLowerCase() ?? UNATTRIBUTED;
    let agent = byAgent.get(key);
    if (!agent) {
      agent = {
        name: botId ? (nameOf.get(key) ?? `(unknown agent ${botId.slice(0, 8)}…)`) : '(unattributed)',
        months: new Map(),
      };
      byAgent.set(key, agent);
    }
    let m = agent.months.get(month);
    if (!m) {
      m = { month, sessions: 0, aiToolCC: 0, estimatedConversationalCC: null };
      agent.months.set(month, m);
    }
    return m;
  };

  let minDate: string | null = null;
  let maxDate: string | null = null;
  const seenDate = (iso: string) => {
    const d = iso.slice(0, 10);
    if (!d) return;
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  };

  for (const s of sessions) {
    if (!s.startTime) continue;
    seenDate(s.startTime);
    bucket(s.botId, monthKey(s.startTime)).sessions += 1;
  }

  let hints = 0;
  for (const e of mcsRatedEvents) {
    seenDate(e.processingDate);
    const hint = extractAgentHint(e.eventData);
    if (hint) hints += 1;
    // A hint that matches a known bot id attributes the credits; otherwise unattributed.
    const botId = hint && nameOf.has(hint.toLowerCase()) ? hint : null;
    bucket(botId, monthKey(e.processingDate)).aiToolCC += e.forecastCopilotCredits ?? 0;
  }

  if (creditsPerSessionEstimate !== null) {
    for (const agent of byAgent.values()) {
      for (const m of agent.months.values()) {
        m.estimatedConversationalCC = m.sessions * creditsPerSessionEstimate;
      }
    }
  }

  const result: AgentConsumption[] = [...byAgent.entries()]
    .map(([key, a]) => {
      const months = [...a.months.values()].sort((x, y) => x.month.localeCompare(y.month));
      return {
        botId: key === UNATTRIBUTED ? null : key,
        agentName: a.name,
        months,
        totalSessions: months.reduce((s, m) => s + m.sessions, 0),
        totalAiToolCC: months.reduce((s, m) => s + m.aiToolCC, 0),
        totalEstimatedCC:
          creditsPerSessionEstimate === null
            ? null
            : months.reduce((s, m) => s + (m.estimatedConversationalCC ?? 0), 0),
      };
    })
    .sort((x, y) => y.totalSessions - x.totalSessions);

  const notes: string[] = [
    'Billing truth per agent = PPAC > Licensing > Copilot Studio > Manage Agents (month-to-date billed credits). This view is for trends, attribution and reconciliation.',
    'Sessions are measured from conversationtranscript metadata only — conversation content is never read or cached.',
    'Session window is limited by the environment’s transcript retention setting.',
  ];
  if (!transcriptsAttributed) {
    notes.push('Transcript→agent lookup column not available in this environment — sessions shown unattributed.');
  }
  if (creditsPerSessionEstimate === null) {
    notes.push(
      'Conversational credits not estimated: set "consumptionEstimate.creditsPerSession" in sizer.config.json to enable (opt-in estimate; zero-rated M365 Copilot usage cannot be distinguished and would be overestimated).'
    );
  } else {
    notes.push(
      `ESTIMATE: conversational credits = sessions × ${creditsPerSessionEstimate} (operator-configured). Reconcile monthly against Manage Agents.`
    );
  }

  return {
    environmentUrl,
    window: { from: minDate, to: maxDate },
    agents: result,
    transcriptsAttributed,
    mcsEventCount: mcsRatedEvents.length,
    mcsEventsWithAgentHint: hints,
    creditsPerSessionEstimate,
    notes,
  };
}
