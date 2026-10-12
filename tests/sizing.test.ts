import { describe, expect, it } from 'vitest';
import { loadRateTables, type SizerConfig } from '../src/config.js';
import { RateMapper } from '../src/domain/rate-mapper.js';
import { computeSizing, packsNeeded, pickPeak } from '../src/domain/sizing.js';
import { makeTagged } from './helpers.js';
import type { MonthlyAggregate } from '../src/types.js';

const config: SizerConfig = {
  growthBuffer: 0.2,
  packSizeCredits: 25000,
  monthsLookback: 12,
  validationDeltaThreshold: 0.05,
  excludeQuickTests: true,
  excludeFailedRuns: true,
  excludeTrialRows: true,
  numberLocale: 'en-US',
  csvFallbackConversionFactor: 0.25,
  environments: [],
};

function month(key: string, forecast: number): MonthlyAggregate {
  return {
    month: key,
    events: 1,
    aibCredits: 0,
    ccCredits: 0,
    forecastCopilotCredits: forecast,
    unmappedEvents: 0,
    unmappedAibCredits: 0,
  };
}

describe('peak month and pack math', () => {
  it('picks the peak month, not the average', () => {
    const peak = pickPeak([month('2026-04', 30000), month('2026-05', 41000), month('2026-06', 12000)], '2026-07');
    expect(peak?.month).toBe('2026-05');
    expect(peak?.forecastCopilotCredits).toBe(41000);
    expect(peak?.isPartialCurrentMonth).toBe(false);
  });

  it('flags the peak when it is the partial current month', () => {
    const peak = pickPeak([month('2026-06', 10), month('2026-07', 20)], '2026-07');
    expect(peak?.isPartialCurrentMonth).toBe(true);
  });

  it('packs = ceil(peak x (1+buffer) / packSize)', () => {
    expect(packsNeeded(41000, 0.2, 25000)).toEqual({ bufferedCredits: 49200, packs: 2 });
    expect(packsNeeded(25000, 0.2, 25000).packs).toBe(2); // 30,000 -> 2 packs
    expect(packsNeeded(20000, 0.2, 25000).packs).toBe(1); // 24,000 -> 1 pack
    expect(packsNeeded(0, 0.2, 25000).packs).toBe(0);
  });
});

describe('computeSizing end-to-end', () => {
  const { aib, cc } = loadRateTables();
  const mapper = new RateMapper(aib, cc);
  const now = new Date('2026-07-13T12:00:00Z');

  it('aggregates per environment/month, excludes quick tests and failures, sizes tenant vs per-env', () => {
    const envA = 'https://a.crm.dynamics.com';
    const envB = 'https://b.crm.dynamics.com';
    const events = (env: string) => [
      // May: 1,000 invoice pages = 32,000 AIB -> 8,000 CC
      ...Array.from({ length: 10 }, () =>
        makeTagged({
          environmentUrl: env,
          processingDate: '2026-05-10T08:00:00Z',
          templateName: 'Invoice processing',
          creditConsumed: 3200,
        })
      ),
      // June: 100 invoice pages -> 800 CC
      makeTagged({
        environmentUrl: env,
        processingDate: '2026-06-10T08:00:00Z',
        templateName: 'Invoice processing',
        creditConsumed: 3200,
      }),
      // excluded: quick test + failed run
      makeTagged({
        environmentUrl: env,
        processingDate: '2026-05-11T08:00:00Z',
        templateName: 'Invoice processing',
        creditConsumed: 999999,
        quickTest: true,
      }),
      makeTagged({
        environmentUrl: env,
        processingDate: '2026-05-11T09:00:00Z',
        templateName: 'Invoice processing',
        creditConsumed: 888888,
        processingStatus: 1,
      }),
      // unmapped AIB event: excluded from forecast, listed separately
      makeTagged({
        environmentUrl: env,
        processingDate: '2026-05-12T08:00:00Z',
        templateName: 'Mystery model',
        modelName: 'zzz',
        name: 'zzz',
        creditConsumed: 500,
      }),
    ];
    const rated = new Map(
      [envA, envB].map((env) => [env, events(env).map((e) => mapper.rateEvent(e))])
    );

    const result = computeSizing(rated, [], config, now);

    const a = result.environments.find((e) => e.environmentUrl === envA)!;
    const may = a.months.find((m) => m.month === '2026-05')!;
    expect(may.forecastCopilotCredits).toBeCloseTo(8000);
    expect(may.aibCredits).toBe(32500); // includes the unmapped 500, not the excluded runs
    expect(may.unmappedAibCredits).toBe(500);
    expect(a.peak?.month).toBe('2026-05');
    // 8,000 x 1.2 = 9,600 -> 1 pack per environment
    expect(a.packs).toBe(1);

    // Tenant: 16,000 CC peak x 1.2 = 19,200 -> 1 pack pooled, 2 packs per-env
    expect(result.tenant.peak?.forecastCopilotCredits).toBeCloseTo(16000);
    expect(result.tenant.packs).toBe(1);
    expect(result.tenant.sumOfEnvironmentPacks).toBe(2);

    expect(result.unmapped).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('EXCLUDED from the forecast'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('retention'))).toBe(true); // short window detected
  });

  it('aggregates per-user consumption with a (not recorded) bucket', () => {
    const env = 'https://u.crm.dynamics.com';
    const events = [
      makeTagged({
        environmentUrl: env, processingDate: '2026-05-10T08:00:00Z',
        templateName: 'Invoice processing', creditConsumed: 320,
        userId: 'U1', userName: 'Anna Schmidt',
      }),
      makeTagged({
        environmentUrl: env, processingDate: '2026-06-10T08:00:00Z',
        templateName: 'Invoice processing', creditConsumed: 32,
        userId: 'U1', userName: 'Anna Schmidt',
      }),
      makeTagged({
        environmentUrl: env, processingDate: '2026-06-11T08:00:00Z',
        templateName: 'Invoice processing', creditConsumed: 64,
      }), // no user -> (not recorded)
    ].map((e) => mapper.rateEvent(e));
    const result = computeSizing(new Map([[env, events]]), [], config, now);
    const users = result.environments[0].users;
    const anna = users.find((u) => u.userName === 'Anna Schmidt')!;
    expect(anna.events).toBe(2);
    expect(anna.aibCredits).toBe(352);
    expect(anna.forecastCopilotCredits).toBeCloseTo(88); // 352/32*8
    expect(anna.monthsActive).toBe(2);
    expect(users.find((u) => u.userName === '(not recorded)')?.aibCredits).toBe(64);
  });
});
