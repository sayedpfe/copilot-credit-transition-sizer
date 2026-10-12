import type { ConsumptionSource, CurrencyTag, RawAiEvent, TaggedEvent } from '../types.js';
import { parseEventData } from '../ingest/eventdata-parser.js';

/** msdyn_consumptionsource option set (entity reference, retrieved 2026-07-13):
 * 0 = PowerAutomation, 1 = PowerApps, 2 = API, 3 = MCS. */
export function mapConsumptionSource(code: number | null): ConsumptionSource {
  switch (code) {
    case 0:
      return 'PowerAutomate';
    case 1:
      return 'PowerApps';
    case 2:
      return 'API';
    case 3:
      return 'CopilotStudio';
    default:
      return 'Unknown';
  }
}

/**
 * Currency rules (see README §Currency rules for the doc citations):
 * 1. An explicit currency indicator inside msdyn_eventdata always wins.
 * 2. Copilot Studio context (MCS) always consumes Copilot Credits -> inferred-CC.
 * 3. Power Apps / Power Automate / API context consumes AI Builder credits first,
 *    falling back to Copilot Credits only on exhaustion. Without an explicit
 *    indicator the AIB-first default applies -> inferred-AIB.
 */
export function tagCurrency(
  source: ConsumptionSource,
  currencyHint: 'AIB' | 'CC' | null
): CurrencyTag {
  if (currencyHint === 'CC') return 'CC';
  if (currencyHint === 'AIB') return 'AIB';
  if (source === 'CopilotStudio') return 'inferred-CC';
  return 'inferred-AIB';
}

export function tagEvent(event: RawAiEvent): TaggedEvent {
  const parsed = parseEventData(event.eventData);
  const source = mapConsumptionSource(event.consumptionSource);
  return { ...event, source, currency: tagCurrency(source, parsed.currencyHint), parsed };
}

export function isCopilotCurrency(tag: CurrencyTag): boolean {
  return tag === 'CC' || tag === 'inferred-CC';
}
