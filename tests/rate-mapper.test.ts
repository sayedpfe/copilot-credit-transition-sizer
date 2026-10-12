import { describe, expect, it } from 'vitest';
import { loadRateTables } from '../src/config.js';
import { RateMapper } from '../src/domain/rate-mapper.js';
import { makeTagged } from './helpers.js';

const { aib, cc } = loadRateTables();
const mapper = new RateMapper(aib, cc);

describe('capability matching + Copilot Credit re-rating (rate-table driven)', () => {
  it('invoice processing: 32 AIB credits -> 1 page -> 8 CC (rate inversion)', () => {
    const rated = mapper.rateEvent(
      makeTagged({ templateName: 'Invoice processing', creditConsumed: 32 })
    );
    expect(rated.capabilityId).toBe('receipt-invoice-id');
    expect(rated.units).toBeCloseTo(1);
    expect(rated.forecastCopilotCredits).toBeCloseTo(8);
    expect(rated.method).toBe('rate-inversion');
  });

  it('custom document processing: 300 AIB credits -> 3 pages -> 24 CC', () => {
    const rated = mapper.rateEvent(
      makeTagged({ templateName: 'Document processing', modelName: 'Custom Rechnungen', creditConsumed: 300 })
    );
    expect(rated.capabilityId).toBe('custom-document-processing');
    expect(rated.units).toBeCloseTo(3);
    expect(rated.forecastCopilotCredits).toBeCloseTo(24);
  });

  it('prebuilt invoice wins over generic document processing (rate-table order)', () => {
    const rated = mapper.rateEvent(
      makeTagged({ templateName: 'Prebuilt invoice document processing', creditConsumed: 32 })
    );
    expect(rated.capabilityId).toBe('receipt-invoice-id');
  });

  it('basic prompt with token counts uses exact tokens: 3.3K tokens -> 0.33 CC', () => {
    const rated = mapper.rateEvent(
      makeTagged({
        templateName: 'GPT prompt',
        creditConsumed: 4,
        eventData: JSON.stringify({ inputTokens: 3000, outputTokens: 300, model: 'gpt-4o-mini' }),
      })
    );
    expect(rated.capabilityId).toBe('prompt-basic');
    expect(rated.method).toBe('eventdata-tokens');
    expect(rated.forecastCopilotCredits).toBeCloseTo(0.33);
  });

  it('basic prompt without tokens uses blended inversion: 12 AIB / 1.2 = 10K tokens -> 1 CC', () => {
    const rated = mapper.rateEvent(makeTagged({ templateName: 'GPT prompt', creditConsumed: 12 }));
    expect(rated.capabilityId).toBe('prompt-basic');
    expect(rated.method).toBe('rate-inversion');
    expect(rated.units).toBeCloseTo(10);
    expect(rated.forecastCopilotCredits).toBeCloseTo(1);
  });

  it('prompt tier resolves from the LLM model name (standard, premium), else basic', () => {
    const standard = mapper.rateEvent(
      makeTagged({
        templateName: 'GPT prompt',
        creditConsumed: 24,
        eventData: JSON.stringify({ model: 'gpt-4o' }),
      })
    );
    expect(standard.capabilityId).toBe('prompt-standard');

    const premium = mapper.rateEvent(
      makeTagged({
        templateName: 'GPT prompt',
        creditConsumed: 182,
        eventData: JSON.stringify({ model: 'o1' }),
      })
    );
    expect(premium.capabilityId).toBe('prompt-premium');

    const unknownLlm = mapper.rateEvent(
      makeTagged({ templateName: 'GPT prompt', creditConsumed: 12, eventData: null })
    );
    expect(unknownLlm.capabilityId).toBe('prompt-basic'); // documented default tier
  });

  it('events already in Copilot Credits pass through unchanged', () => {
    const rated = mapper.rateEvent(
      makeTagged({ consumptionSource: 3, templateName: 'Invoice processing', creditConsumed: 8 })
    );
    expect(rated.method).toBe('cc-passthrough');
    expect(rated.forecastCopilotCredits).toBe(8);
  });

  it('free capabilities forecast 0 (business card / prediction)', () => {
    const rated = mapper.rateEvent(
      makeTagged({ templateName: 'Prediction', creditConsumed: 0 })
    );
    expect(rated.method).toBe('free');
    expect(rated.forecastCopilotCredits).toBe(0);
  });

  it('unknown AIB capability lands in the unmapped bucket, never guessed', () => {
    const rated = mapper.rateEvent(
      makeTagged({ templateName: 'Mystery future model', modelName: 'zzz', name: 'zzz', creditConsumed: 50 })
    );
    expect(rated.method).toBe('unmapped');
    expect(rated.forecastCopilotCredits).toBeNull();
  });

  it('unknown capability already in CC still passes through (no guessing involved)', () => {
    const rated = mapper.rateEvent(
      makeTagged({
        consumptionSource: 3,
        templateName: 'Mystery future model',
        modelName: 'zzz',
        name: 'zzz',
        creditConsumed: 50,
      })
    );
    expect(rated.method).toBe('cc-passthrough');
    expect(rated.forecastCopilotCredits).toBe(50);
  });

  it('OCR: 3 AIB credits -> 1 page -> 0.1 CC (factor ~0.033)', () => {
    const rated = mapper.rateEvent(
      makeTagged({ templateName: 'Text recognition', creditConsumed: 3 })
    );
    expect(rated.forecastCopilotCredits).toBeCloseTo(0.1);
  });
});
