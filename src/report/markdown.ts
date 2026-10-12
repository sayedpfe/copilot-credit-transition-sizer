import type { SizingResult } from '../types.js';
import { makeFormatter } from './format.js';

/** Customer-ready executive summary. Numbers formatted per config.numberLocale. */
export function renderMarkdownReport(result: SizingResult, locale: string): string {
  const f = makeFormatter(locale);
  const lines: string[] = [];
  const tenant = result.tenant;

  lines.push('# Copilot Credit Transition Sizing Report');
  lines.push('');
  lines.push(`_Generated: ${result.generatedAt} (UTC) — credit-transition-sizer_`);
  lines.push('');
  lines.push('## Why this report exists');
  lines.push('');
  lines.push(
    'Microsoft is retiring AI Builder credits. Seeded AI Builder credits included in Power Platform ' +
      'premium licenses will be **removed on November 1, 2026**, with **no conversion** into Copilot ' +
      'Credits ([End of AI Builder credits](https://learn.microsoft.com/en-us/ai-builder/endofaibcredits)). ' +
      'From that date, all AI Builder capabilities — in Power Apps, Power Automate, and Copilot Studio — ' +
      'consume **Copilot Credits** only. This report sizes the Copilot Credit purchase from actual usage.'
  );
  lines.push('');
  lines.push('## Recommendation');
  lines.push('');
  if (tenant.peak) {
    lines.push(
      `- **Peak month (all environments):** ${tenant.peak.month} at ` +
        `**${f.int(tenant.peak.forecastCopilotCredits)} Copilot Credits** (all usage re-rated into Copilot Credits).` +
        (tenant.peak.isPartialCurrentMonth ? ' ⚠️ This is the current, partial month.' : '')
    );
    lines.push(
      `- **With ${f.pct(result.growthBuffer)} growth buffer:** ${f.int(tenant.bufferedCredits)} Copilot Credits per month.`
    );
    lines.push(
      `- **Prepaid packs (tenant pool):** **${tenant.packs} pack(s)** of ${f.int(result.packSizeCredits)} ` +
        `Copilot Credits/month.`
    );
    lines.push(
      `- **Prepaid packs (per-environment allocation):** ${tenant.sumOfEnvironmentPacks} pack(s) in total.`
    );
    if (tenant.sumOfEnvironmentPacks > tenant.packs) {
      lines.push(
        `- **Allocation advice:** pooling at tenant level needs ${tenant.sumOfEnvironmentPacks - tenant.packs} ` +
          `fewer pack(s) than per-environment allocation, because environment peaks fall in different months. ` +
          `Prefer the tenant pool unless specific environments need guaranteed, isolated capacity.`
      );
    } else {
      lines.push(
        '- **Allocation advice:** per-environment allocation costs no extra packs here; use it if you want hard capacity isolation per environment.'
      );
    }
  } else {
    lines.push('- No consumption data found in the ingested window.');
  }
  lines.push('');

  lines.push('## Per-environment sizing');
  lines.push('');
  lines.push('| Environment | Data window | Peak month | Peak forecast (CC) | +Buffer | Packs |');
  lines.push('|---|---|---|---:|---:|---:|');
  for (const env of result.environments) {
    const window =
      env.window.from && env.window.to
        ? `${env.window.from.slice(0, 10)} → ${env.window.to.slice(0, 10)} (${env.window.monthsWithData} mo)`
        : 'no data';
    lines.push(
      `| ${env.environmentName || env.environmentUrl} | ${window} | ${env.peak?.month ?? '—'} | ` +
        `${f.int(env.peak?.forecastCopilotCredits ?? 0)} | ${f.int(env.bufferedCredits)} | ${env.packs} |`
    );
  }
  lines.push('');

  const envsWithFlows = result.environments.filter((e) => e.flows.length > 0);
  if (envsWithFlows.length > 0) {
    lines.push('## What each flow, app, and agent will need');
    lines.push('');
    lines.push(
      '_Copilot Credits per month, from actual runs. "Peak month" is that flow\'s own busiest month; ' +
        'the environment total is the busiest single month with all flows together (usually less than the sum ' +
        'of individual peaks, because flows peak at different times)._'
    );
    lines.push('');
    for (const env of envsWithFlows) {
      lines.push(`### ${env.environmentName || env.environmentUrl}`);
      lines.push('');
      lines.push('| Flow / App / Agent | Used from | Runs | CC / average month | CC / peak month |');
      lines.push('|---|---|---:|---:|---:|');
      for (const flow of env.flows.slice(0, 15)) {
        lines.push(
          `| ${flow.automationName} | ${flow.sources} | ${f.int(flow.events)} | ` +
            `${f.num(Math.round(flow.averageMonthlyCC * 10) / 10)} | ${f.num(Math.round(flow.peakMonthCC * 10) / 10)} |`
        );
      }
      if (env.flows.length > 15) {
        lines.push(`| _… ${env.flows.length - 15} more (see xlsx Per-Flow sheet)_ | | | | |`);
      }
      lines.push(
        `| **Environment total (peak month ${env.peak?.month ?? '—'})** | | | | ` +
          `**${f.int(env.peak?.forecastCopilotCredits ?? 0)}** |`
      );
      lines.push('');
    }
  }

  const envsWithUsers = result.environments.filter((e) => e.users.length > 0);
  if (envsWithUsers.length > 0) {
    lines.push('## Consumption by user');
    lines.push('');
    lines.push(
      '_The user is the run\'s creating identity. Caveat: flow-triggered runs record the executing identity — ' +
        'often the flow/connection owner — not necessarily the person who triggered the flow._'
    );
    lines.push('');
    for (const env of envsWithUsers) {
      lines.push(`### ${env.environmentName || env.environmentUrl}`);
      lines.push('');
      lines.push('| User | Runs | AIB credits | CC observed | Forecast CC |');
      lines.push('|---|---:|---:|---:|---:|');
      for (const user of env.users.slice(0, 10)) {
        lines.push(
          `| ${user.userName} | ${f.int(user.events)} | ${f.int(user.aibCredits)} | ${f.int(user.ccCredits)} | ` +
            `${f.num(Math.round(user.forecastCopilotCredits * 100) / 100)} |`
        );
      }
      if (env.users.length > 10) {
        lines.push(`| _… ${env.users.length - 10} more (see xlsx Per-User sheet)_ | | | | |`);
      }
      lines.push('');
    }
  }

  lines.push('## How the numbers are calculated');
  lines.push('');
  lines.push('Worked example — one flow processes a 20-page invoice batch:');
  lines.push('');
  lines.push('```');
  lines.push('Observed:  the run consumed 640 AI Builder credits (invoice processing)');
  lines.push('Step 1:    640 AIB credits ÷ 32 AIB credits/page  = 20 pages of work');
  lines.push('Step 2:    20 pages × 8 Copilot Credits/page      = 160 Copilot Credits');
  lines.push('           → after Nov 1, 2026 this exact run will cost 160 Copilot Credits');
  lines.push('```');
  lines.push('');
  lines.push('Then, per environment:');
  lines.push('');
  lines.push('```');
  lines.push('all runs re-priced → summed per calendar month → take the HIGHEST month (peak)');
  lines.push(
    `packs to buy = peak × ${(1 + result.growthBuffer).toFixed(2)} (growth buffer) ÷ ${f.int(result.packSizeCredits)} per pack, rounded up`
  );
  lines.push('```');
  lines.push('');
  lines.push(
    '_Why the peak and not the average: unused Copilot Credits expire at the end of each month, ' +
      'so the subscription must cover the busiest month. Prompts (GPT) are priced from their exact token ' +
      'counts when the event recorded them. Runs already paid in Copilot Credits (agents, agent flows) are ' +
      'taken over unchanged. Every rate comes from Microsoft\'s published dual-currency rate table (sources below)._'
  );
  lines.push('');

  lines.push('## Monthly forecast detail (tenant)');
  lines.push('');
  lines.push('| Month | Observed AIB credits | Observed Copilot Credits | Forecast Copilot Credits |');
  lines.push('|---|---:|---:|---:|');
  for (const m of tenant.months) {
    lines.push(
      `| ${m.month} | ${f.int(m.aibCredits)} | ${f.int(m.ccCredits)} | ${f.int(m.forecastCopilotCredits)} |`
    );
  }
  lines.push('');

  lines.push('## Method and assumptions');
  lines.push('');
  lines.push(
    '1. **Data source:** ' +
      (result.csvFallback
        ? `PPAC AI Builder consumption report (CSV fallback). A single blended conversion factor of ` +
          `${result.csvFallbackConversionFactor} Copilot Credits per AI Builder credit was applied because the ` +
          `report has no per-capability detail. Treat this as a rough estimate.`
        : 'Dataverse AI Event table (`msdyn_aievent`) per environment, read-only.')
  );
  lines.push(
    '2. **Forecast:** 100% of observed consumption — both currencies — is re-rated into Copilot Credits, ' +
      'because after November 1, 2026 this tenant has no AI Builder credits (seeded credits only, no add-ons). ' +
      'There is no official conversion ratio between the currencies; the re-rating derives capability units ' +
      'from the published dual-currency rate table and prices them at the Copilot Credit rate.'
  );
  lines.push(
    '3. **Sizing basis:** the peak calendar month, not the average — unused Copilot Credits do not roll over ' +
      'and consumption resets on the 1st of each month.'
  );
  lines.push(
    '4. **Prompts:** where the event payload includes token counts, exact input/output token rates are used; ' +
      "otherwise Microsoft's published 90/10 input/output blend is assumed."
  );
  lines.push(
    '5. **Unmapped events** are excluded from the forecast and listed separately — they are never silently ' +
      'dropped or guessed.'
  );
  lines.push('');

  if (result.warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const warning of result.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  lines.push('## Sources (Microsoft Learn, retrieved 2026-07-13)');
  lines.push('');
  lines.push('- [End of AI Builder credits](https://learn.microsoft.com/en-us/ai-builder/endofaibcredits) (GA)');
  lines.push('- [Licensing and AI Builder credits](https://learn.microsoft.com/en-us/ai-builder/credit-management) (GA)');
  lines.push('- [Licensing and Copilot Credits](https://learn.microsoft.com/en-us/ai-builder/message-management) (GA)');
  lines.push('- [Overview of licensing — AI Builder capability rate table](https://learn.microsoft.com/en-us/ai-builder/administer-licensing) (GA)');
  lines.push('- [AI Builder consumption report](https://learn.microsoft.com/en-us/ai-builder/administer-consumption-report) (GA)');
  lines.push('- [Monitor AI Builder activity](https://learn.microsoft.com/en-us/ai-builder/activity-monitoring) (GA)');
  lines.push('- [Copilot Studio billing rates](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management) (GA)');
  lines.push('- [Copilot Studio licensing](https://learn.microsoft.com/en-us/microsoft-copilot-studio/billing-licensing) (GA)');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    '> **Disclaimer:** estimates only. This tool reads the `msdyn_aievent` table, which Microsoft documents ' +
      'as a schema reference rather than a supported consumption-reporting API, and applies published list ' +
      'rates that Microsoft may change. Verify all figures against the Microsoft Power Platform Licensing ' +
      'Guide and the Copilot Credit Guide before purchasing.'
  );
  lines.push('');
  return lines.join('\n');
}
