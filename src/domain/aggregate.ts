import type {
  CapabilityAggregate,
  DataWindow,
  FlowAggregate,
  MonthlyAggregate,
  RatedEvent,
  UserAggregate,
} from '../types.js';
import { isCopilotCurrency } from './currency-tagger.js';
import type { SizerConfig } from '../config.js';

export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7); // YYYY-MM (dates are stored UTC)
}

/** Apply config filters: quick tests are free, failed runs don't consume. */
export function filterCountableEvents(events: RatedEvent[], config: SizerConfig): RatedEvent[] {
  return events.filter((event) => {
    if (config.excludeQuickTests && event.quickTest) return false;
    if (config.excludeFailedRuns && event.processingStatus === 1) return false;
    return true;
  });
}

export function aggregateMonths(events: RatedEvent[]): MonthlyAggregate[] {
  const byMonth = new Map<string, MonthlyAggregate>();
  for (const event of events) {
    const key = monthKey(event.processingDate);
    let agg = byMonth.get(key);
    if (!agg) {
      agg = {
        month: key,
        events: 0,
        aibCredits: 0,
        ccCredits: 0,
        forecastCopilotCredits: 0,
        unmappedEvents: 0,
        unmappedAibCredits: 0,
      };
      byMonth.set(key, agg);
    }
    agg.events += 1;
    if (isCopilotCurrency(event.currency)) {
      agg.ccCredits += event.creditConsumed;
    } else {
      agg.aibCredits += event.creditConsumed;
    }
    if (event.method === 'unmapped') {
      agg.unmappedEvents += 1;
      agg.unmappedAibCredits += event.creditConsumed;
    } else if (event.forecastCopilotCredits !== null) {
      agg.forecastCopilotCredits += event.forecastCopilotCredits;
    }
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export function aggregateCapabilities(events: RatedEvent[]): CapabilityAggregate[] {
  const byCapability = new Map<string, CapabilityAggregate>();
  for (const event of events) {
    const id = event.capabilityId ?? '(unmapped)';
    let agg = byCapability.get(id);
    if (!agg) {
      agg = {
        capabilityId: id,
        capabilityName: event.capabilityName ?? '(unmapped)',
        events: 0,
        aibCredits: 0,
        ccCredits: 0,
        units: 0,
        unitKind: event.unitKind,
        forecastCopilotCredits: 0,
        effectiveConversionFactor: null,
      };
      byCapability.set(id, agg);
    }
    agg.events += 1;
    if (isCopilotCurrency(event.currency)) {
      agg.ccCredits += event.creditConsumed;
    } else {
      agg.aibCredits += event.creditConsumed;
    }
    if (event.units !== null) agg.units += event.units;
    if (event.forecastCopilotCredits !== null) {
      agg.forecastCopilotCredits += event.forecastCopilotCredits;
    }
  }
  for (const agg of byCapability.values()) {
    // Only meaningful for AIB consumption that was re-rated (not CC passthrough).
    agg.effectiveConversionFactor =
      agg.aibCredits > 0
        ? (agg.forecastCopilotCredits - agg.ccCredits) / agg.aibCredits
        : null;
  }
  return [...byCapability.values()].sort(
    (a, b) => b.forecastCopilotCredits - a.forecastCopilotCredits
  );
}

/** Rollup per consumer — the customer-facing "what does each flow/app/agent need"
 * view. Grouping key is msdyn_automationname when recorded; otherwise the event is
 * grouped by its source and model (e.g. "(PowerApps: Sentiment analysis)"), so Power
 * Apps and API consumption stays readable instead of collapsing into one bucket. */
export function aggregateFlows(events: RatedEvent[]): FlowAggregate[] {
  interface Acc extends FlowAggregate {
    monthCC: Map<string, number>;
    sourceSet: Set<string>;
  }
  const byFlow = new Map<string, Acc>();
  for (const event of events) {
    const name =
      event.automationName?.trim() ||
      `(${event.source}: ${event.modelName ?? event.capabilityName ?? 'unknown model'})`;
    let acc = byFlow.get(name);
    if (!acc) {
      acc = {
        automationName: name,
        sources: '',
        events: 0,
        aibCredits: 0,
        ccCredits: 0,
        forecastCopilotCredits: 0,
        monthsActive: 0,
        averageMonthlyCC: 0,
        peakMonth: null,
        peakMonthCC: 0,
        monthCC: new Map(),
        sourceSet: new Set(),
      };
      byFlow.set(name, acc);
    }
    acc.events += 1;
    acc.sourceSet.add(event.source);
    if (isCopilotCurrency(event.currency)) {
      acc.ccCredits += event.creditConsumed;
    } else {
      acc.aibCredits += event.creditConsumed;
    }
    if (event.forecastCopilotCredits !== null) {
      acc.forecastCopilotCredits += event.forecastCopilotCredits;
      const month = monthKey(event.processingDate);
      acc.monthCC.set(month, (acc.monthCC.get(month) ?? 0) + event.forecastCopilotCredits);
    }
  }
  return [...byFlow.values()]
    .map((acc) => {
      const { monthCC, sourceSet, ...flow } = acc;
      flow.sources = [...sourceSet].sort().join(', ');
      flow.monthsActive = monthCC.size;
      flow.averageMonthlyCC =
        monthCC.size > 0 ? flow.forecastCopilotCredits / monthCC.size : 0;
      for (const [month, cc] of monthCC) {
        if (cc > flow.peakMonthCC) {
          flow.peakMonthCC = cc;
          flow.peakMonth = month;
        }
      }
      return flow;
    })
    .sort((a, b) => b.peakMonthCC - a.peakMonthCC);
}

/** Rollup per user (createdby identity). Attribution caveat: flow-triggered runs
 * record the executing identity — often the flow/connection owner, not the human
 * who triggered the flow. App runs attribute more directly. Events from caches
 * ingested before this field existed group under '(not recorded)'. */
export function aggregateUsers(events: RatedEvent[]): UserAggregate[] {
  interface Acc extends UserAggregate {
    months: Set<string>;
  }
  const byUser = new Map<string, Acc>();
  for (const event of events) {
    const key = event.userId?.toLowerCase() ?? '(not recorded)';
    let acc = byUser.get(key);
    if (!acc) {
      acc = {
        userId: event.userId ?? '(not recorded)',
        userName: event.userName ?? (event.userId ? `(id ${event.userId.slice(0, 8)}…)` : '(not recorded)'),
        events: 0,
        aibCredits: 0,
        ccCredits: 0,
        forecastCopilotCredits: 0,
        monthsActive: 0,
        months: new Set<string>(),
      };
      byUser.set(key, acc);
    }
    acc.events += 1;
    if (isCopilotCurrency(event.currency)) {
      acc.ccCredits += event.creditConsumed;
    } else {
      acc.aibCredits += event.creditConsumed;
    }
    if (event.forecastCopilotCredits !== null) {
      acc.forecastCopilotCredits += event.forecastCopilotCredits;
    }
    acc.months.add(monthKey(event.processingDate));
  }
  return [...byUser.values()]
    .map(({ months, ...user }) => ({ ...user, monthsActive: months.size }))
    .sort((a, b) => b.forecastCopilotCredits - a.forecastCopilotCredits);
}

/** Actual data window vs requested lookback — msdyn_aievent retention is often shorter. */
export function detectWindow(events: RatedEvent[], requestedMonths: number): DataWindow {
  if (events.length === 0) {
    return { from: null, to: null, monthsWithData: 0, requestedMonths };
  }
  const dates = events.map((e) => e.processingDate).sort();
  const months = new Set(events.map((e) => monthKey(e.processingDate)));
  return {
    from: dates[0],
    to: dates[dates.length - 1],
    monthsWithData: months.size,
    requestedMonths,
  };
}
