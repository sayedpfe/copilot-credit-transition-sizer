import type { RawAiEvent } from '../src/types.js';
import { tagEvent } from '../src/domain/currency-tagger.js';

let counter = 0;

/** Synthetic AI event factory — all data fabricated, no customer data. */
export function makeRaw(overrides: Partial<RawAiEvent> = {}): RawAiEvent {
  counter += 1;
  return {
    id: `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`,
    name: 'synthetic event',
    processingDate: '2026-06-15T10:00:00Z',
    processingStatus: 0,
    consumptionSource: 0,
    creditConsumed: 32,
    quickTest: false,
    modelName: 'Synthetic model',
    templateName: null,
    automationName: null,
    userId: null,
    userName: null,
    eventData: null,
    environmentUrl: 'https://synthetic.crm.dynamics.com',
    ...overrides,
  };
}

export function makeTagged(overrides: Partial<RawAiEvent> = {}) {
  return tagEvent(makeRaw(overrides));
}
