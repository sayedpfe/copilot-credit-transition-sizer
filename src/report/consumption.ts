import type { AgentConsumptionResult } from '../domain/agent-consumption.js';
import { makeFormatter } from './format.js';

export function printAgentConsumption(result: AgentConsumptionResult, locale: string): void {
  const f = makeFormatter(locale);
  console.log('');
  console.log(`=== Agent consumption — ${result.environmentUrl} ===`);
  console.log(
    `  window: ${result.window.from ?? '—'} → ${result.window.to ?? '—'} | ` +
      `MCS AI-tool events: ${result.mcsEventCount} (${result.mcsEventsWithAgentHint} with agent hint in eventdata)`
  );
  console.log('');
  for (const agent of result.agents) {
    const est =
      agent.totalEstimatedCC === null ? '' : ` | est. conversational CC: ${f.int(agent.totalEstimatedCC)}`;
    console.log(
      `  ${agent.agentName}: ${f.int(agent.totalSessions)} sessions | AI-tool CC: ${f.num(Math.round(agent.totalAiToolCC * 100) / 100)}${est}`
    );
    for (const m of agent.months.slice(-3)) {
      console.log(
        `      ${m.month}: ${f.int(m.sessions)} sessions, ${f.num(Math.round(m.aiToolCC * 100) / 100)} AI-tool CC` +
          (m.estimatedConversationalCC === null ? '' : `, ~${f.int(m.estimatedConversationalCC)} est. CC`)
      );
    }
  }
  console.log('');
  for (const note of result.notes) console.log(`  ! ${note}`);
  console.log('');
}

export function renderAgentConsumptionMarkdown(result: AgentConsumptionResult, locale: string): string {
  const f = makeFormatter(locale);
  const lines: string[] = [];
  lines.push(`# Agent Consumption Report — ${result.environmentUrl}`);
  lines.push('');
  lines.push(`_Window: ${result.window.from ?? '—'} → ${result.window.to ?? '—'}_`);
  lines.push('');
  lines.push('| Agent | Sessions | AI-tool Copilot Credits (measured) | Conversational CC (estimate) |');
  lines.push('|---|---:|---:|---:|');
  for (const agent of result.agents) {
    lines.push(
      `| ${agent.agentName} | ${f.int(agent.totalSessions)} | ${f.num(Math.round(agent.totalAiToolCC * 100) / 100)} | ` +
        `${agent.totalEstimatedCC === null ? 'n/a (opt-in)' : '~' + f.int(agent.totalEstimatedCC)} |`
    );
  }
  lines.push('');
  lines.push('## Monthly detail');
  lines.push('');
  lines.push('| Agent | Month | Sessions | AI-tool CC | Est. conversational CC |');
  lines.push('|---|---|---:|---:|---:|');
  for (const agent of result.agents) {
    for (const m of agent.months) {
      lines.push(
        `| ${agent.agentName} | ${m.month} | ${f.int(m.sessions)} | ${f.num(Math.round(m.aiToolCC * 100) / 100)} | ` +
          `${m.estimatedConversationalCC === null ? '—' : '~' + f.int(m.estimatedConversationalCC)} |`
      );
    }
  }
  lines.push('');
  lines.push('## Method & honesty notes');
  lines.push('');
  for (const note of result.notes) lines.push(`- ${note}`);
  lines.push('');
  lines.push(
    '> This report replaces per-agent trend visibility lost with the retired v0.1-alpha licensing endpoint. ' +
      'It is built only on documented, supported surfaces (Dataverse `bot`, `conversationtranscript`, `msdyn_aievent`). ' +
      'Authoritative billed credits per agent: PPAC → Licensing → Copilot Studio → Manage Agents.'
  );
  lines.push('');
  return lines.join('\n');
}

export function renderAgentConsumptionCsv(result: AgentConsumptionResult): string {
  const rows = ['environment,agent,month,sessions,aiToolCopilotCredits,estimatedConversationalCC'];
  for (const agent of result.agents) {
    for (const m of agent.months) {
      rows.push(
        [
          result.environmentUrl,
          `"${agent.agentName.replaceAll('"', "'")}"`,
          m.month,
          m.sessions,
          Math.round(m.aiToolCC * 100) / 100,
          m.estimatedConversationalCC ?? '',
        ].join(',')
      );
    }
  }
  return rows.join('\n') + '\n';
}
