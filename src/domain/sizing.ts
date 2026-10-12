import type {
  EnvironmentSizing,
  MonthlyAggregate,
  RatedEvent,
  SizingResult,
} from '../types.js';
import type { SizerConfig, EnvironmentRef } from '../config.js';
import {
  aggregateCapabilities,
  aggregateFlows,
  aggregateMonths,
  aggregateUsers,
  detectWindow,
  filterCountableEvents,
} from './aggregate.js';

export interface PeakInfo {
  month: string;
  forecastCopilotCredits: number;
  isPartialCurrentMonth: boolean;
}

/** Peak month drives the sizing: unused Copilot Credits do not roll over, so the
 * purchase must cover the highest month, not the average. */
export function pickPeak(months: MonthlyAggregate[], currentMonth: string): PeakInfo | null {
  if (months.length === 0) return null;
  const peak = months.reduce((best, m) =>
    m.forecastCopilotCredits > best.forecastCopilotCredits ? m : best
  );
  return {
    month: peak.month,
    forecastCopilotCredits: peak.forecastCopilotCredits,
    isPartialCurrentMonth: peak.month === currentMonth,
  };
}

export function packsNeeded(credits: number, growthBuffer: number, packSize: number): {
  bufferedCredits: number;
  packs: number;
} {
  const buffered = credits * (1 + growthBuffer);
  return { bufferedCredits: buffered, packs: buffered <= 0 ? 0 : Math.ceil(buffered / packSize) };
}

export function sumMonthsAcrossEnvironments(perEnv: MonthlyAggregate[][]): MonthlyAggregate[] {
  const byMonth = new Map<string, MonthlyAggregate>();
  for (const months of perEnv) {
    for (const m of months) {
      let agg = byMonth.get(m.month);
      if (!agg) {
        agg = {
          month: m.month,
          events: 0,
          aibCredits: 0,
          ccCredits: 0,
          forecastCopilotCredits: 0,
          unmappedEvents: 0,
          unmappedAibCredits: 0,
        };
        byMonth.set(m.month, agg);
      }
      agg.events += m.events;
      agg.aibCredits += m.aibCredits;
      agg.ccCredits += m.ccCredits;
      agg.forecastCopilotCredits += m.forecastCopilotCredits;
      agg.unmappedEvents += m.unmappedEvents;
      agg.unmappedAibCredits += m.unmappedAibCredits;
    }
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export function computeSizing(
  eventsByEnvironment: Map<string, RatedEvent[]>,
  environmentRefs: EnvironmentRef[],
  config: SizerConfig,
  now: Date = new Date()
): SizingResult {
  const currentMonth = now.toISOString().slice(0, 7);
  const warnings: string[] = [];
  const environments: EnvironmentSizing[] = [];
  const allUnmapped: RatedEvent[] = [];

  for (const [environmentUrl, rawEvents] of eventsByEnvironment) {
    const ref = environmentRefs.find((r) => r.url.toLowerCase() === environmentUrl.toLowerCase());
    const events = filterCountableEvents(rawEvents, config);
    const months = aggregateMonths(events);
    const capabilities = aggregateCapabilities(events);
    const flows = aggregateFlows(events);
    const users = aggregateUsers(events);
    const window = detectWindow(events, config.monthsLookback);
    const peak = pickPeak(months, currentMonth);
    const { bufferedCredits, packs } = packsNeeded(
      peak?.forecastCopilotCredits ?? 0,
      config.growthBuffer,
      config.packSizeCredits
    );

    const unmapped = events.filter((e) => e.method === 'unmapped');
    allUnmapped.push(...unmapped);
    if (unmapped.length > 0) {
      const credits = unmapped.reduce((sum, e) => sum + e.creditConsumed, 0);
      warnings.push(
        `${environmentUrl}: ${unmapped.length} event(s) totaling ${credits} AI Builder credits could not be ` +
          `mapped to a capability and are EXCLUDED from the forecast. Review the Unmapped sheet and extend ` +
          `config/rate-tables/aibuilder-rates.json match patterns.`
      );
    }
    if (window.monthsWithData > 0 && window.monthsWithData < config.monthsLookback) {
      warnings.push(
        `${environmentUrl}: only ${window.monthsWithData} month(s) of data available ` +
          `(requested ${config.monthsLookback}). msdyn_aievent retention may be shorter than the lookback ` +
          `(bulk-deletion jobs); the peak month is derived from the available window only.`
      );
    }
    if (peak?.isPartialCurrentMonth) {
      warnings.push(
        `${environmentUrl}: the peak month ${peak.month} is the current (partial) month — ` +
          `the full-month figure will be higher. Re-run after month end before finalizing the purchase.`
      );
    }

    environments.push({
      environmentUrl,
      environmentName: ref?.name || null,
      environmentId: ref?.environmentId || null,
      window,
      months,
      capabilities,
      flows,
      users,
      peak,
      bufferedCredits,
      packs,
    });
  }

  const tenantMonths = sumMonthsAcrossEnvironments(environments.map((e) => e.months));
  const tenantPeak = pickPeak(tenantMonths, currentMonth);
  const tenantPacks = packsNeeded(
    tenantPeak?.forecastCopilotCredits ?? 0,
    config.growthBuffer,
    config.packSizeCredits
  );

  return {
    generatedAt: now.toISOString(),
    growthBuffer: config.growthBuffer,
    packSizeCredits: config.packSizeCredits,
    environments,
    tenant: {
      months: tenantMonths,
      peak: tenantPeak,
      bufferedCredits: tenantPacks.bufferedCredits,
      packs: tenantPacks.packs,
      sumOfEnvironmentPacks: environments.reduce((sum, e) => sum + e.packs, 0),
    },
    unmapped: allUnmapped,
    csvFallback: false,
    warnings,
  };
}

/**
 * Fallback sizing from the PPAC consumption report only (no capability detail).
 * Applies one blended AIB->CC conversion factor from config — loudly flagged.
 */
export function computeSizingFromPpac(
  monthlyAibByEnvironment: Map<string, Map<string, number>>,
  config: SizerConfig,
  now: Date = new Date()
): SizingResult {
  const currentMonth = now.toISOString().slice(0, 7);
  const factor = config.csvFallbackConversionFactor;
  const environments: EnvironmentSizing[] = [];

  for (const [environment, byMonth] of monthlyAibByEnvironment) {
    const months: MonthlyAggregate[] = [...byMonth.entries()]
      .map(([month, aibCredits]) => ({
        month,
        events: 0,
        aibCredits,
        ccCredits: 0,
        forecastCopilotCredits: aibCredits * factor,
        unmappedEvents: 0,
        unmappedAibCredits: 0,
      }))
      .sort((a, b) => a.month.localeCompare(b.month));
    const peak = pickPeak(months, currentMonth);
    const { bufferedCredits, packs } = packsNeeded(
      peak?.forecastCopilotCredits ?? 0,
      config.growthBuffer,
      config.packSizeCredits
    );
    environments.push({
      environmentUrl: environment,
      environmentName: environment,
      environmentId: null,
      window: {
        from: months[0]?.month ?? null,
        to: months[months.length - 1]?.month ?? null,
        monthsWithData: months.length,
        requestedMonths: config.monthsLookback,
      },
      months,
      capabilities: [],
      flows: [],
      users: [],
      peak,
      bufferedCredits,
      packs,
    });
  }

  const tenantMonths = sumMonthsAcrossEnvironments(environments.map((e) => e.months));
  const tenantPeak = pickPeak(tenantMonths, currentMonth);
  const tenantPacks = packsNeeded(
    tenantPeak?.forecastCopilotCredits ?? 0,
    config.growthBuffer,
    config.packSizeCredits
  );

  return {
    generatedAt: now.toISOString(),
    growthBuffer: config.growthBuffer,
    packSizeCredits: config.packSizeCredits,
    environments,
    tenant: {
      months: tenantMonths,
      peak: tenantPeak,
      bufferedCredits: tenantPacks.bufferedCredits,
      packs: tenantPacks.packs,
      sumOfEnvironmentPacks: environments.reduce((sum, e) => sum + e.packs, 0),
    },
    unmapped: [],
    csvFallback: true,
    csvFallbackConversionFactor: factor,
    warnings: [
      `CSV FALLBACK MODE: the PPAC consumption report has no per-capability detail, so a single blended ` +
        `conversion factor of ${factor} Copilot Credits per AI Builder credit was applied ` +
        `(config: csvFallbackConversionFactor). The PPAC report also covers a rolling 30 days only and ` +
        `excludes Copilot Studio consumption. Prefer Dataverse ingestion for a defensible sizing.`,
    ],
  };
}
