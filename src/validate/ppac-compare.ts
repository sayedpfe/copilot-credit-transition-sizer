import type { PpacRow, RatedEvent, ValidationRow } from '../types.js';
import type { SizerConfig, EnvironmentRef } from '../config.js';
import { filterCountableEvents, monthKey } from '../domain/aggregate.js';
import { isCopilotCurrency } from '../domain/currency-tagger.js';

/**
 * Compares the tool's AI Builder credit totals per environment against the PPAC
 * "AI Builder consumption report" for one calendar month. Deltas above the
 * configured threshold are flagged. Note: PPAC computation can lag five or more
 * days (endofaibcredits FAQ) and the export covers a rolling 30 days.
 */
export function comparePpac(
  eventsByEnvironment: Map<string, RatedEvent[]>,
  ppacRows: PpacRow[],
  environmentRefs: EnvironmentRef[],
  config: SizerConfig,
  month: string // YYYY-MM
): ValidationRow[] {
  const rows: ValidationRow[] = [];

  const usableRows = ppacRows.filter(
    (r) => (!config.excludeTrialRows || !r.isTrial) && monthKey(r.date) === month
  );

  const ppacByEnvId = new Map<string, number>();
  const ppacByEnvName = new Map<string, number>();
  for (const row of usableRows) {
    if (row.environmentId) {
      const key = row.environmentId.toLowerCase();
      ppacByEnvId.set(key, (ppacByEnvId.get(key) ?? 0) + row.aiConsumption);
    }
    if (row.environmentName) {
      const key = row.environmentName.toLowerCase();
      ppacByEnvName.set(key, (ppacByEnvName.get(key) ?? 0) + row.aiConsumption);
    }
  }

  const singlePpacEnv =
    new Set(usableRows.map((r) => r.environmentId ?? r.environmentName ?? '')).size === 1;

  for (const [environmentUrl, rawEvents] of eventsByEnvironment) {
    const events = filterCountableEvents(rawEvents, config);
    const toolTotal = events
      .filter((e) => monthKey(e.processingDate) === month && !isCopilotCurrency(e.currency))
      .reduce((sum, e) => sum + e.creditConsumed, 0);

    const ref = environmentRefs.find((r) => r.url.toLowerCase() === environmentUrl.toLowerCase());
    let ppacTotal: number | null = null;
    let note = '';

    if (ref?.environmentId && ppacByEnvId.has(ref.environmentId.toLowerCase())) {
      ppacTotal = ppacByEnvId.get(ref.environmentId.toLowerCase())!;
      note = 'matched by environmentId';
    } else if (ref?.name && ppacByEnvName.has(ref.name.toLowerCase())) {
      ppacTotal = ppacByEnvName.get(ref.name.toLowerCase())!;
      note = 'matched by environment name';
    } else if (eventsByEnvironment.size === 1 && singlePpacEnv && usableRows.length > 0) {
      ppacTotal = usableRows.reduce((sum, r) => sum + r.aiConsumption, 0);
      note = 'single environment on both sides — assumed match (set environmentId in config to be explicit)';
    }

    if (ppacTotal === null) {
      rows.push({
        environment: environmentUrl,
        month,
        toolAibCredits: toolTotal,
        ppacAibCredits: 0,
        deltaRatio: null,
        flagged: false,
        note:
          'no PPAC match — set "environmentId" (GUID from the PPAC report / environment URL in the maker portal) ' +
          'or "name" for this environment in config/sizer.config.json',
      });
      continue;
    }

    const deltaRatio = ppacTotal === 0 ? (toolTotal === 0 ? 0 : null) : (toolTotal - ppacTotal) / ppacTotal;
    const flagged = deltaRatio === null || Math.abs(deltaRatio) > config.validationDeltaThreshold;
    rows.push({
      environment: environmentUrl,
      month,
      toolAibCredits: toolTotal,
      ppacAibCredits: ppacTotal,
      deltaRatio,
      flagged,
      note:
        note +
        (flagged
          ? ' — delta exceeds threshold. PPAC computation can lag 5+ days; if the month is recent, re-download the report and re-check before investigating further.'
          : ''),
    });
  }
  return rows;
}
