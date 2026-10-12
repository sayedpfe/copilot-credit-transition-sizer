import { describe, expect, it } from 'vitest';
import { mapConsumptionSource, tagCurrency, tagEvent } from '../src/domain/currency-tagger.js';
import { makeRaw } from './helpers.js';

describe('consumption source mapping (msdyn_consumptionsource option set)', () => {
  it('maps documented option values', () => {
    expect(mapConsumptionSource(0)).toBe('PowerAutomate');
    expect(mapConsumptionSource(1)).toBe('PowerApps');
    expect(mapConsumptionSource(2)).toBe('API');
    expect(mapConsumptionSource(3)).toBe('CopilotStudio');
    expect(mapConsumptionSource(null)).toBe('Unknown');
    expect(mapConsumptionSource(99)).toBe('Unknown');
  });
});

describe('currency tagging rules', () => {
  it('Copilot Studio context is always Copilot Credits (inferred without explicit hint)', () => {
    expect(tagCurrency('CopilotStudio', null)).toBe('inferred-CC');
  });

  it('Power Apps / Power Automate context defaults to AI Builder credits first', () => {
    expect(tagCurrency('PowerAutomate', null)).toBe('inferred-AIB');
    expect(tagCurrency('PowerApps', null)).toBe('inferred-AIB');
    expect(tagCurrency('API', null)).toBe('inferred-AIB');
  });

  it('explicit eventdata currency wins over inference (overage fallback case)', () => {
    // Classic flow whose AIB credits were exhausted: eventdata says Copilot Credit.
    expect(tagCurrency('PowerAutomate', 'CC')).toBe('CC');
    // Explicit AIB indicator in a Copilot Studio row would win too (trust event data).
    expect(tagCurrency('CopilotStudio', 'AIB')).toBe('AIB');
  });

  it('tags a full event end-to-end using eventdata hints', () => {
    const ccEvent = tagEvent(
      makeRaw({
        consumptionSource: 0,
        eventData: JSON.stringify({ creditType: 'CopilotCredit', inputTokens: 900, outputTokens: 100 }),
      })
    );
    expect(ccEvent.currency).toBe('CC');
    expect(ccEvent.parsed.totalTokens).toBe(1000);

    const aibEvent = tagEvent(makeRaw({ consumptionSource: 1, eventData: null }));
    expect(aibEvent.currency).toBe('inferred-AIB');

    const mcsEvent = tagEvent(makeRaw({ consumptionSource: 3, eventData: '{not valid json' }));
    expect(mcsEvent.currency).toBe('inferred-CC');
    expect(mcsEvent.parsed.parseError).toBe(true);
  });
});
