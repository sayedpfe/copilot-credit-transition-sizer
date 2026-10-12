import { describe, expect, it } from 'vitest';
import { buildAgentConsumption, extractAgentHint } from '../src/domain/agent-consumption.js';
import { loadRateTables } from '../src/config.js';
import { RateMapper } from '../src/domain/rate-mapper.js';
import { makeTagged } from './helpers.js';

const AGENTS = [
  { botId: 'AAAA1111-0000-0000-0000-000000000001', name: 'HR Agent', schemaName: null },
  { botId: 'AAAA1111-0000-0000-0000-000000000002', name: 'IT Agent', schemaName: null },
];

describe('per-agent consumption view', () => {
  it('extracts agent hints from eventdata defensively', () => {
    expect(extractAgentHint('{"botId":"aaaa1111-0000-0000-0000-000000000001"}')).toBe(
      'aaaa1111-0000-0000-0000-000000000001'
    );
    expect(extractAgentHint('{"context":{"agent_id":"xyz"}}')).toBe('xyz');
    expect(extractAgentHint('{"model":"gpt-4o"}')).toBeNull();
    expect(extractAgentHint('not json')).toBeNull();
    expect(extractAgentHint(null)).toBeNull();
  });

  it('aggregates sessions per agent per month; estimates only when opted in', () => {
    const sessions = [
      { id: '1', startTime: '2026-06-03T10:00:00Z', botId: AGENTS[0].botId },
      { id: '2', startTime: '2026-06-04T10:00:00Z', botId: AGENTS[0].botId },
      { id: '3', startTime: '2026-07-01T10:00:00Z', botId: AGENTS[1].botId },
      { id: '4', startTime: '2026-07-02T10:00:00Z', botId: null },
    ];
    // opt-in estimate: 10 CC per session
    const withEstimate = buildAgentConsumption('https://x.crm.dynamics.com', AGENTS, sessions, true, [], 10);
    const hr = withEstimate.agents.find((a) => a.agentName === 'HR Agent')!;
    expect(hr.totalSessions).toBe(2);
    expect(hr.months[0]).toMatchObject({ month: '2026-06', sessions: 2, estimatedConversationalCC: 20 });
    expect(withEstimate.agents.find((a) => a.agentName === '(unattributed)')?.totalSessions).toBe(1);

    // default: no estimate
    const noEstimate = buildAgentConsumption('https://x.crm.dynamics.com', AGENTS, sessions, true, [], null);
    expect(noEstimate.agents[0].totalEstimatedCC).toBeNull();
    expect(noEstimate.notes.some((n) => n.includes('opt-in'))).toBe(true);
  });

  it('merges MCS AI-tool credits, attributing via eventdata hints when they match a known agent', () => {
    const { aib, cc } = loadRateTables();
    const mapper = new RateMapper(aib, cc);
    const mcs = [
      makeTagged({
        consumptionSource: 3,
        templateName: 'GPT prompt',
        creditConsumed: 8,
        processingDate: '2026-07-05T09:00:00Z',
        eventData: `{"model":"gpt-4o-mini","botId":"${AGENTS[0].botId}"}`,
      }),
      makeTagged({
        consumptionSource: 3,
        templateName: 'GPT prompt',
        creditConsumed: 4,
        processingDate: '2026-07-06T09:00:00Z',
        eventData: '{"model":"gpt-4o-mini"}', // no hint -> unattributed
      }),
    ].map((e) => mapper.rateEvent(e));

    const result = buildAgentConsumption('https://x.crm.dynamics.com', AGENTS, [], true, mcs, null);
    const hr = result.agents.find((a) => a.agentName === 'HR Agent')!;
    expect(hr.totalAiToolCC).toBe(8); // CC passthrough for MCS rows
    expect(result.agents.find((a) => a.agentName === '(unattributed)')?.totalAiToolCC).toBe(4);
    expect(result.mcsEventsWithAgentHint).toBe(1);
  });
});
