import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePpacCsv } from '../src/ingest/ppac-report.js';
import { mapEventRow } from '../src/ingest/dataverse.js';
import { comparePpac } from '../src/validate/ppac-compare.js';
import { RateMapper } from '../src/domain/rate-mapper.js';
import { loadRateTables, type SizerConfig } from '../src/config.js';
import { makeTagged } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const csvText = readFileSync(resolve(here, 'fixtures', 'ppac-report-sample.csv'), 'utf8');

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

describe('PPAC consumption report CSV parser', () => {
  it('parses the documented columns (Date, UserId, EnvironmentId, EnvironmentName, AIConsumption, IsTrial)', () => {
    const rows = parsePpacCsv(csvText);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      date: '2026-07-01',
      environmentId: 'eeeeeeee-0000-0000-0000-000000000001',
      environmentName: 'Synthetic Prod',
      aiConsumption: 1200,
      isTrial: false,
    });
    expect(rows[4].isTrial).toBe(true);
  });

  it('handles M/D/YYYY dates and shuffled/case-variant headers', () => {
    const rows = parsePpacCsv(
      'AICONSUMPTION,date,environmentname\n42,7/4/2026,Env X\n'
    );
    expect(rows[0]).toMatchObject({ date: '2026-07-04', aiConsumption: 42, environmentName: 'Env X' });
  });

  it('rejects files without the mandatory columns', () => {
    expect(() => parsePpacCsv('Foo,Bar\n1,2\n')).toThrow(/Unrecognized PPAC report format/);
  });

  it('parses the Oct-2026 schema (UserEmail/ConsumptionUnits/StartDateTime)', () => {
    const rows = parsePpacCsv(
      'UserId,UserEmail,EnvironmentId,IsTrial,ConsumptionUnits,StartDateTime,EndDateTime\n' +
        'aaaa-1,user.one@contoso.com,Default-eeee-1,false,37175.0,2026-09-03T00:00:00,2026-09-04T00:00:00\n' +
        'aaaa-2,user.two@contoso.com,0cde-2,false,13.0,2026-10-06T00:00:00,2026-10-07T00:00:00\n'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: '2026-09-03',
      userEmail: 'user.one@contoso.com',
      environmentId: 'Default-eeee-1',
      aiConsumption: 37175,
      isTrial: false,
    });
    expect(rows[1].aiConsumption).toBe(13);
  });
});

describe('Dataverse row mapping', () => {
  it('maps OData rows including the model join and null model', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(here, 'fixtures', 'aievents-odata-sample.json'), 'utf8')
    ) as { value: Record<string, unknown>[] };
    const modelMap = new Map([
      ['bbbbbbbb-0000-0000-0000-000000000001', { name: 'Invoices', templateName: 'Invoice processing' }],
      ['bbbbbbbb-0000-0000-0000-000000000002', { name: 'HR prompt', templateName: 'GPT prompt' }],
    ]);
    const events = fixture.value.map((row) =>
      mapEventRow(row, 'https://synthetic.crm.dynamics.com', modelMap)
    );
    expect(events[0]).toMatchObject({
      templateName: 'Invoice processing',
      creditConsumed: 32,
      consumptionSource: 0,
    });
    expect(events[1].templateName).toBe('GPT prompt');
    expect(events[2].modelName).toBeNull();
    expect(events[2].quickTest).toBe(true);
  });
});

describe('validation against PPAC (current-month comparison)', () => {
  const { aib, cc } = loadRateTables();
  const mapper = new RateMapper(aib, cc);
  const env = 'https://synthetic.crm.dynamics.com';

  function ratedEvents(totalAib: number) {
    return [
      mapper.rateEvent(
        makeTagged({
          environmentUrl: env,
          processingDate: '2026-07-02T10:00:00Z',
          templateName: 'Invoice processing',
          creditConsumed: totalAib,
        })
      ),
    ];
  }

  it('matches by environmentId and passes within threshold (trial rows excluded)', () => {
    // PPAC July for Synthetic Prod, excluding trial: 1200+800+500 = 2500
    const rows = comparePpac(
      new Map([[env, ratedEvents(2500)]]),
      parsePpacCsv(csvText),
      [{ url: env, environmentId: 'eeeeeeee-0000-0000-0000-000000000001', name: '' }],
      config,
      '2026-07'
    );
    expect(rows[0].ppacAibCredits).toBe(2500);
    expect(rows[0].deltaRatio).toBe(0);
    expect(rows[0].flagged).toBe(false);
  });

  it('flags deltas above 5%', () => {
    const rows = comparePpac(
      new Map([[env, ratedEvents(3000)]]),
      parsePpacCsv(csvText),
      [{ url: env, environmentId: 'eeeeeeee-0000-0000-0000-000000000001', name: '' }],
      config,
      '2026-07'
    );
    expect(rows[0].deltaRatio).toBeCloseTo(0.2);
    expect(rows[0].flagged).toBe(true);
    expect(rows[0].note).toContain('PPAC computation can lag');
  });

  it('reports missing mapping instead of guessing when multiple environments exist', () => {
    const other = 'https://other.crm.dynamics.com';
    const rows = comparePpac(
      new Map([
        [env, ratedEvents(2500)],
        [other, ratedEvents(1)],
      ]),
      parsePpacCsv(csvText),
      [],
      config,
      '2026-07'
    );
    expect(rows.every((r) => r.note.includes('no PPAC match'))).toBe(true);
  });
});
