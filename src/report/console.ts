import type { SizingResult, ValidationRow } from '../types.js';
import { makeFormatter } from './format.js';

export function printSizingSummary(result: SizingResult, locale: string): void {
  const f = makeFormatter(locale);
  const t = result.tenant;

  console.log('');
  console.log('=== Copilot Credit Transition Sizing ===');
  if (result.csvFallback) {
    console.log(
      `MODE: PPAC CSV fallback (blended factor ${result.csvFallbackConversionFactor} CC per AIB credit)`
    );
  }
  console.log('');
  for (const env of result.environments) {
    const label = env.environmentName || env.environmentUrl;
    const window =
      env.window.from && env.window.to
        ? `${env.window.from.slice(0, 10)} → ${env.window.to.slice(0, 10)} (${env.window.monthsWithData} mo of ${env.window.requestedMonths} requested)`
        : 'no data';
    console.log(`  ${label}`);
    console.log(`    data window : ${window}`);
    console.log(
      `    peak month  : ${env.peak?.month ?? '—'}  →  ${f.int(env.peak?.forecastCopilotCredits ?? 0)} CC forecast`
    );
    console.log(`    with buffer : ${f.int(env.bufferedCredits)} CC  →  ${env.packs} pack(s)`);
    for (const flow of env.flows.slice(0, 5)) {
      console.log(
        `      - ${flow.automationName}: ~${f.int(flow.averageMonthlyCC)} CC/month (peak ${f.int(flow.peakMonthCC)} in ${flow.peakMonth ?? '—'})`
      );
    }
    if (env.flows.length > 5) {
      console.log(`      … ${env.flows.length - 5} more flows (see Per-Flow sheet)`);
    }
  }
  console.log('');
  console.log(
    `  TENANT peak ${t.peak?.month ?? '—'}: ${f.int(t.peak?.forecastCopilotCredits ?? 0)} CC ` +
      `→ +buffer ${f.int(t.bufferedCredits)} → ${t.packs} pack(s) of ${f.int(result.packSizeCredits)} CC/month`
  );
  console.log(`  Sum of per-environment packs: ${t.sumOfEnvironmentPacks}`);
  console.log('');
  if (result.warnings.length > 0) {
    console.log('  Warnings:');
    for (const warning of result.warnings) console.log(`   ! ${warning}`);
    console.log('');
  }
}

export function printValidation(rows: ValidationRow[], locale: string, threshold: number): void {
  const f = makeFormatter(locale);
  console.log('');
  console.log(`=== Validation vs PPAC consumption report (flag threshold ${f.pct(threshold)}) ===`);
  console.log('');
  for (const row of rows) {
    const delta = row.deltaRatio === null ? 'n/a' : f.pct(row.deltaRatio);
    const flag = row.flagged ? '  << FLAGGED' : '';
    console.log(`  ${row.environment}  [${row.month}]`);
    console.log(
      `    tool: ${f.int(row.toolAibCredits)} AIB credits | PPAC: ${f.int(row.ppacAibCredits)} | delta: ${delta}${flag}`
    );
    if (row.note) console.log(`    note: ${row.note}`);
  }
  console.log('');
  console.log(
    '  Note: PPAC consumption computation can lag 5+ days (endofaibcredits FAQ), and the report covers a rolling 30 days.'
  );
  console.log('');
}
