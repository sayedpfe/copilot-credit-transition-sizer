import ExcelJS from 'exceljs';
import type { SizingResult } from '../types.js';

const MAX_UNMAPPED_ROWS = 5000;
const HEADER_FILL: ExcelJS.FillPattern = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1F3864' },
};

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER_FILL;
}

export async function writeXlsxReport(result: SizingResult, filePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'credit-transition-sizer';
  workbook.created = new Date(result.generatedAt);

  // ---- Summary ----
  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 46 }, { width: 70 }];
  const addKV = (key: string, value: string | number) => summary.addRow([key, value]);

  summary.addRow(['Copilot Credit Transition Sizing — Summary']).font = { bold: true, size: 14 };
  summary.addRow([]);
  addKV('Generated at (UTC)', result.generatedAt);
  addKV('Sizing basis', 'Peak calendar month (unused Copilot Credits do not roll over)');
  addKV('Growth buffer', `${Math.round(result.growthBuffer * 100)}%`);
  addKV('Pack size', `${result.packSizeCredits} Copilot Credits / month`);
  if (result.csvFallback) {
    addKV(
      'MODE',
      `PPAC CSV FALLBACK — blended conversion factor ${result.csvFallbackConversionFactor} applied (no capability detail)`
    );
  }
  summary.addRow([]);
  addKV('Tenant peak month', result.tenant.peak?.month ?? 'n/a');
  addKV('Tenant peak forecast (Copilot Credits)', Math.round(result.tenant.peak?.forecastCopilotCredits ?? 0));
  addKV('Tenant peak + buffer', Math.round(result.tenant.bufferedCredits));
  addKV('Prepaid packs — tenant pool', result.tenant.packs);
  addKV('Prepaid packs — sum of per-environment allocations', result.tenant.sumOfEnvironmentPacks);
  addKV(
    'Recommendation',
    result.tenant.sumOfEnvironmentPacks > result.tenant.packs
      ? `Tenant-level pooling needs ${result.tenant.sumOfEnvironmentPacks - result.tenant.packs} fewer pack(s) than per-environment allocation. Prefer the tenant pool unless environments need hard capacity isolation.`
      : 'Per-environment allocation and tenant pooling need the same pack count; choose per-environment allocation if you want hard capacity isolation.'
  );
  summary.addRow([]);
  summary.addRow(['Warnings']).font = { bold: true };
  for (const warning of result.warnings) summary.addRow(['', warning]);

  // ---- Per-Environment ----
  const perEnv = workbook.addWorksheet('Per-Environment');
  perEnv.columns = [
    { header: 'Environment', key: 'env', width: 46 },
    { header: 'Month', key: 'month', width: 10 },
    { header: 'Events', key: 'events', width: 10 },
    { header: 'AI Builder credits (observed)', key: 'aib', width: 26 },
    { header: 'Copilot Credits (observed)', key: 'cc', width: 24 },
    { header: 'Forecast Copilot Credits (100% re-rated)', key: 'forecast', width: 34 },
    { header: 'Unmapped events', key: 'unmappedEvents', width: 16 },
    { header: 'Unmapped AIB credits (excluded)', key: 'unmappedCredits', width: 28 },
  ];
  styleHeader(perEnv.getRow(1));
  for (const env of result.environments) {
    for (const m of env.months) {
      perEnv.addRow({
        env: env.environmentName || env.environmentUrl,
        month: m.month,
        events: m.events,
        aib: m.aibCredits,
        cc: m.ccCredits,
        forecast: Math.round(m.forecastCopilotCredits * 100) / 100,
        unmappedEvents: m.unmappedEvents,
        unmappedCredits: m.unmappedAibCredits,
      });
    }
    const peakRow = perEnv.addRow({
      env: env.environmentName || env.environmentUrl,
      month: 'PEAK',
      forecast: Math.round((env.peak?.forecastCopilotCredits ?? 0) * 100) / 100,
      unmappedEvents: undefined,
      unmappedCredits: undefined,
    });
    peakRow.getCell('aib').value = `+${Math.round(result.growthBuffer * 100)}% buffer → ${Math.ceil(env.bufferedCredits)}`;
    peakRow.getCell('cc').value = `packs: ${env.packs}`;
    peakRow.font = { bold: true };
  }

  // ---- Per-Flow (customer-facing: what each flow/app/agent will need) ----
  const perFlow = workbook.addWorksheet('Per-Flow');
  perFlow.columns = [
    { header: 'Environment', key: 'env', width: 40 },
    { header: 'Flow / App / Agent', key: 'flow', width: 44 },
    { header: 'Used from', key: 'sources', width: 26 },
    { header: 'Runs', key: 'events', width: 9 },
    { header: 'Copilot Credits needed — average month', key: 'avg', width: 30 },
    { header: 'Copilot Credits needed — peak month', key: 'peak', width: 28 },
    { header: 'Peak month', key: 'peakMonth', width: 12 },
  ];
  styleHeader(perFlow.getRow(1));
  for (const env of result.environments) {
    for (const flow of env.flows) {
      perFlow.addRow({
        env: env.environmentName || env.environmentUrl,
        flow: flow.automationName,
        sources: flow.sources,
        events: flow.events,
        avg: Math.round(flow.averageMonthlyCC * 10) / 10,
        peak: Math.round(flow.peakMonthCC * 10) / 10,
        peakMonth: flow.peakMonth ?? '',
      });
    }
    const totalRow = perFlow.addRow({
      env: env.environmentName || env.environmentUrl,
      flow: 'ENVIRONMENT TOTAL (peak month, all flows together)',
      peak: Math.round((env.peak?.forecastCopilotCredits ?? 0) * 10) / 10,
      peakMonth: env.peak?.month ?? '',
    });
    totalRow.font = { bold: true };
  }
  perFlow.addRow({});
  perFlow.addRow({
    env: 'Note: the environment total is the peak of all flows in the SAME month — it is usually less than the sum of each flow’s individual peak, because flows peak in different months.',
  }).font = { italic: true };

  // ---- Per-User ----
  const perUser = workbook.addWorksheet('Per-User');
  perUser.columns = [
    { header: 'Environment', key: 'env', width: 40 },
    { header: 'User', key: 'user', width: 34 },
    { header: 'User ID', key: 'uid', width: 38 },
    { header: 'Runs', key: 'events', width: 9 },
    { header: 'AI Builder credits (observed)', key: 'aib', width: 26 },
    { header: 'Copilot Credits (observed)', key: 'cc', width: 24 },
    { header: 'Forecast Copilot Credits', key: 'forecast', width: 24 },
    { header: 'Months active', key: 'months', width: 13 },
  ];
  styleHeader(perUser.getRow(1));
  for (const env of result.environments) {
    for (const user of env.users) {
      perUser.addRow({
        env: env.environmentName || env.environmentUrl,
        user: user.userName,
        uid: user.userId,
        events: user.events,
        aib: user.aibCredits,
        cc: user.ccCredits,
        forecast: Math.round(user.forecastCopilotCredits * 100) / 100,
        months: user.monthsActive,
      });
    }
  }
  perUser.addRow({});
  perUser.addRow({
    env: 'Attribution note: the user is the run’s creating identity (createdby). Flow-triggered runs record the executing identity — often the flow/connection owner — not necessarily the person who triggered the flow. App runs attribute more directly.',
  }).font = { italic: true };

  // ---- How it is calculated ----
  const calc = workbook.addWorksheet('How it is calculated');
  calc.columns = [{ width: 6 }, { width: 120 }];
  const step = (n: string, text: string) => calc.addRow([n, text]);
  calc.addRow(['', 'How the Copilot Credit numbers are calculated']).font = { bold: true, size: 13 };
  calc.addRow([]);
  step('1', 'Every AI run in the environment is read from the Dataverse AI Event table (one row per run, with its consumed credits and the flow/app that triggered it).');
  step('2', 'Each run is matched to a Microsoft AI Builder capability (invoice processing, document processing, prompt, …) using its model and template name.');
  step('3', 'The consumed AI Builder credits are converted back into work units using Microsoft’s published AI Builder rate. Example: 640 AI Builder credits for invoice processing ÷ 32 credits/page = 20 pages.');
  step('4', 'The work units are priced in Copilot Credits using Microsoft’s published Copilot Credit rate. Example: 20 pages × 8 Copilot Credits/page = 160 Copilot Credits.');
  step('5', 'For prompts (GPT), the exact token counts from the event are used when available: total tokens ÷ 1000 × rate (0.1 basic / 1.5 standard / 10 premium).');
  step('6', 'Runs that already consumed Copilot Credits (agents, agent flows) are taken over unchanged — no conversion needed.');
  step('7', 'All runs are summed per flow, per environment, and per calendar month. The sizing uses the HIGHEST month (peak), because unused Copilot Credits expire at month end — an average would undersize the peak.');
  step('8', `A growth buffer of ${Math.round(result.growthBuffer * 100)}% is added on top of the peak.`);
  step('9', `The result is divided by ${result.packSizeCredits} (one prepaid pack per month) and rounded UP to whole packs.`);
  calc.addRow([]);
  step('', 'Rates source: AI Builder capability rate table, Microsoft Learn (administer-licensing). Both rate tables ship with this tool as JSON files with version and retrieval date.');
  step('', 'Runs that could not be matched to a capability are NEVER estimated — they are listed on the Unmapped sheet instead.');

  // ---- Per-Capability ----
  const perCap = workbook.addWorksheet('Per-Capability');
  perCap.columns = [
    { header: 'Environment', key: 'env', width: 46 },
    { header: 'Capability', key: 'cap', width: 44 },
    { header: 'Unit', key: 'unit', width: 12 },
    { header: 'Events', key: 'events', width: 10 },
    { header: 'Units consumed', key: 'units', width: 16 },
    { header: 'AI Builder credits (observed)', key: 'aib', width: 26 },
    { header: 'Copilot Credits (observed)', key: 'cc', width: 24 },
    { header: 'Forecast Copilot Credits', key: 'forecast', width: 24 },
    { header: 'Effective CC per AIB credit', key: 'factor', width: 24 },
  ];
  styleHeader(perCap.getRow(1));
  for (const env of result.environments) {
    for (const cap of env.capabilities) {
      perCap.addRow({
        env: env.environmentName || env.environmentUrl,
        cap: cap.capabilityName,
        unit: cap.unitKind ?? '',
        events: cap.events,
        units: Math.round(cap.units * 100) / 100,
        aib: cap.aibCredits,
        cc: cap.ccCredits,
        forecast: Math.round(cap.forecastCopilotCredits * 100) / 100,
        factor:
          cap.effectiveConversionFactor === null
            ? ''
            : Math.round(cap.effectiveConversionFactor * 10000) / 10000,
      });
    }
  }

  // ---- Unmapped ----
  const unmapped = workbook.addWorksheet('Unmapped');
  unmapped.columns = [
    { header: 'Environment', key: 'env', width: 46 },
    { header: 'Processing date', key: 'date', width: 22 },
    { header: 'Event name', key: 'name', width: 34 },
    { header: 'Model', key: 'model', width: 30 },
    { header: 'Template', key: 'template', width: 30 },
    { header: 'Source', key: 'source', width: 14 },
    { header: 'Currency tag', key: 'currency', width: 14 },
    { header: 'Credits consumed', key: 'credits', width: 16 },
  ];
  styleHeader(unmapped.getRow(1));
  unmapped.addRow({
    env: `These events could not be mapped to a capability rate and are EXCLUDED from the forecast. Extend the match patterns in config/rate-tables/aibuilder-rates.json.`,
  }).font = { italic: true };
  for (const event of result.unmapped.slice(0, MAX_UNMAPPED_ROWS)) {
    unmapped.addRow({
      env: event.environmentUrl,
      date: event.processingDate,
      name: event.name ?? '',
      model: event.modelName ?? '',
      template: event.templateName ?? '',
      source: event.source,
      currency: event.currency,
      credits: event.creditConsumed,
    });
  }
  if (result.unmapped.length > MAX_UNMAPPED_ROWS) {
    unmapped.addRow({
      env: `… ${result.unmapped.length - MAX_UNMAPPED_ROWS} more unmapped events truncated (${result.unmapped.length} total).`,
    }).font = { italic: true };
  }

  await workbook.xlsx.writeFile(filePath);
}
