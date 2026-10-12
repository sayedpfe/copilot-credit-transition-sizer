/**
 * SYNTHETIC demo-data generator — no real customer data.
 *
 * Writes a fake two-environment ingest cache into data-demo/ (never data/) plus a
 * matching synthetic PPAC consumption-report CSV, so the full pipeline — forecast,
 * xlsx/md reports, and validate — can be rehearsed without tenant access:
 *
 *   node tools/generate-demo-data.mjs
 *   node dist/cli.js --data-dir ./data-demo forecast
 *   node dist/cli.js --data-dir ./data-demo validate --csv ./data-demo/demo-ppac-prod.csv \
 *        --environment https://contoso-demo-prod.crm.dynamics.com --month <current-month>
 *
 * The dataset is deterministic and shaped to be instructive:
 *  - Prod peaks in Dec (invoice season), Dev peaks in Mar -> tenant pooling beats per-env packs.
 *  - Prompt events carry token payloads (exact re-rating); doc models use rate inversion.
 *  - Includes quick tests, failed runs, Copilot Studio (CC) events, and unmapped legacy models.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'data-demo');
mkdirSync(outDir, { recursive: true });

const now = new Date();
const CURRENT_MONTH = now.toISOString().slice(0, 7);

// 12 months ending in the current month.
const months = [];
for (let i = 11; i >= 0; i--) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
  months.push(d.toISOString().slice(0, 7));
}
const DEC = months.find((m) => m.endsWith('-12')) ?? months[4];
const MAR = months.find((m) => m.endsWith('-03')) ?? months[7];

let seq = 0;
const id = () => `dddddddd-0000-0000-0000-${String(++seq).padStart(12, '0')}`;

function event(env, month, day, fields) {
  const dd = String(Math.min(day, 28)).padStart(2, '0');
  const isCurrentPartial = month === CURRENT_MONTH;
  const maxDay = isCurrentPartial ? Math.max(1, now.getUTCDate() - 1) : 28;
  const effDay = String(Math.min(day, maxDay)).padStart(2, '0') ?? dd;
  return {
    id: id(),
    name: fields.name ?? null,
    processingDate: `${month}-${effDay}T${String((seq % 12) + 6).padStart(2, '0')}:15:00Z`,
    processingStatus: fields.failed ? 1 : 0,
    consumptionSource: fields.mcs ? 3 : fields.app ? 1 : 0,
    creditConsumed: fields.credits,
    quickTest: fields.quickTest ?? false,
    modelName: fields.model,
    templateName: fields.template ?? null,
    automationName: fields.flow ?? null,
    userId: fields.user ? `user-${fields.user.toLowerCase().replace(/[^a-z]/g, '')}-0000-0000-000000000001` : null,
    userName: fields.user ?? null,
    eventData: fields.eventData ?? null,
    environmentUrl: env,
    source: fields.mcs ? 'CopilotStudio' : fields.app ? 'PowerApps' : 'PowerAutomate',
    currency: fields.mcs ? 'inferred-CC' : 'inferred-AIB',
    parsed: {
      currencyHint: null,
      inputTokens: fields.inTok ?? null,
      outputTokens: fields.outTok ?? null,
      totalTokens: fields.inTok != null ? fields.inTok + fields.outTok : null,
      llmModelName: fields.llm ?? null,
      creditValue: null,
      parseError: false,
    },
  };
}

function makeEnvironment(env, profile) {
  const events = [];
  for (const month of months) {
    const invoicePages = profile.invoicePages(month);
    // Invoice processing: 20 pages per event, 32 AIB credits/page.
    for (let i = 0; i < Math.round(invoicePages / 20); i++) {
      events.push(
        event(env, month, (i % 27) + 1, {
          model: 'Rechnungen Eingang',
          template: 'Invoice processing',
          credits: 640,
          flow: 'Invoice intake flow',
          user: 'Automation Service Account',
        })
      );
    }
    // Custom document processing: 20 pages per event, 100 AIB credits/page.
    for (let i = 0; i < profile.customDocEvents(month); i++) {
      events.push(
        event(env, month, (i % 27) + 1, {
          model: 'Lieferschein Verarbeitung',
          template: 'Document processing (custom)',
          credits: 2000,
          flow: 'Delivery note processing flow',
          user: 'Automation Service Account',
        })
      );
    }
    // Basic prompts in flows, WITH token payloads (25K tokens -> 30 AIB credits blend-ish).
    for (let i = 0; i < profile.promptEvents; i++) {
      events.push(
        event(env, month, (i % 27) + 1, {
          model: 'Custom prompt summarize-complaint',
          template: 'GPT prompt',
          credits: 30,
          inTok: 22500,
          outTok: 2500,
          llm: 'gpt-4o-mini',
          eventData: '{"model":"gpt-4o-mini","inputTokens":22500,"outputTokens":2500}',
          flow: 'Complaint summarizer flow',
          user: 'Jonas Weber',
        })
      );
    }
    // Sentiment (simple text analysis): 50K chars per event -> 100 AIB credits.
    for (let i = 0; i < 10; i++) {
      events.push(
        event(env, month, (i % 27) + 1, {
          model: 'Sentiment analysis',
          template: 'Sentiment analysis',
          credits: 100,
          app: true,
          flow: 'Customer feedback app',
          user: 'Maria Lopez',
        })
      );
    }
    // OCR: 10 pages per event -> 30 AIB credits.
    for (let i = 0; i < 10; i++) {
      events.push(
        event(env, month, (i % 27) + 1, {
          model: 'Text recognition',
          template: 'Text recognition',
          credits: 30,
          flow: 'Archive scan flow',
          user: 'Anna Schmidt',
        })
      );
    }
    // Copilot Studio agent prompts (already Copilot Credits).
    for (let i = 0; i < 15; i++) {
      events.push(
        event(env, month, (i % 27) + 1, {
          model: 'HR agent prompt',
          template: 'GPT prompt',
          credits: 2,
          mcs: true,
          llm: 'gpt-4o-mini',
          flow: 'HR Assist agent',
          user: 'HR Agent Service',
        })
      );
    }
    // Conversion showcase: the SAME 3,200 AI Builder credits in four different
    // capabilities -> radically different Copilot Credit needs (1,000 / 800 / 256 / 100).
    // Demonstrates that there is no flat AIB->CC ratio; visible on Per-Flow and
    // Per-Capability sheets via the effective conversion factor.
    if (profile.showcase) {
      for (let i = 0; i < 20; i++) {
        events.push(event(env, month, (i % 27) + 1, {
          model: 'Object detection shelf check', template: 'Object detection',
          credits: 160, flow: 'Same-credits demo: object detection', // 20x160 = 3,200 AIB -> 3,200 CC
        }));
      }
      for (let i = 0; i < 5; i++) {
        events.push(event(env, month, (i % 27) + 1, {
          model: 'Rechnungen Eingang', template: 'Invoice processing',
          credits: 640, flow: 'Same-credits demo: invoice processing', // 5x640 = 3,200 AIB -> 800 CC
        }));
      }
      for (let i = 0; i < 2; i++) {
        events.push(event(env, month, (i % 27) + 1, {
          model: 'Lieferschein Verarbeitung', template: 'Document processing (custom)',
          credits: 1600, flow: 'Same-credits demo: custom documents', // 2x1600 = 3,200 AIB -> 256 CC
        }));
      }
      for (let i = 0; i < 4; i++) {
        events.push(event(env, month, (i % 27) + 1, {
          model: 'Text recognition', template: 'Text recognition',
          credits: 800, flow: 'Same-credits demo: OCR', // 4x800 = 3,200 AIB -> ~107 CC
        }));
      }
    }
    // Unmapped legacy model (excluded from forecast, lands on the Unmapped sheet).
    events.push(
      event(env, month, 15, { model: 'Legacy vision scoring v1', credits: 250 })
    );
    // Excluded noise: quick tests and failed runs.
    events.push(event(env, month, 8, { model: 'Custom prompt summarize-complaint', template: 'GPT prompt', credits: 0, quickTest: true }));
    events.push(event(env, month, 9, { model: 'Rechnungen Eingang', template: 'Invoice processing', credits: 640, failed: true }));
  }
  return events;
}

const PROD = 'https://contoso-demo-prod.crm.dynamics.com';
const DEV = 'https://contoso-demo-dev.crm.dynamics.com';

const prodEvents = makeEnvironment(PROD, {
  invoicePages: (m) => (m === DEC ? 3000 : 700),
  customDocEvents: () => 15, // 300 pages -> 30,000 AIB/mo
  promptEvents: 40,
  showcase: true,
});
const devEvents = makeEnvironment(DEV, {
  invoicePages: () => 100,
  customDocEvents: (m) => (m === MAR ? 60 : 8), // Mar: 1,200 pages -> 120,000 AIB
  promptEvents: 15,
});

for (const [env, events] of [
  [PROD, prodEvents],
  [DEV, devEvents],
]) {
  const file = resolve(outDir, `${new URL(env).host}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      meta: {
        environmentUrl: env,
        retrievedAt: now.toISOString(),
        sinceIso: `${months[0]}-01T00:00:00Z`,
        eventCount: events.length,
        SYNTHETIC: 'Demo data generated by tools/generate-demo-data.mjs — NOT customer measurements.',
      },
      events,
    })
  );
  console.log(`wrote ${events.length} synthetic events -> ${file}`);
}

// Synthetic PPAC report for PROD, current month: daily sums of countable AIB events,
// so `validate` reconciles at ~0% delta. Adds one trial row (excluded by config).
const daily = new Map();
for (const e of prodEvents) {
  const day = e.processingDate.slice(0, 10);
  if (!day.startsWith(CURRENT_MONTH)) continue;
  if (e.quickTest || e.processingStatus === 1 || e.currency === 'inferred-CC') continue;
  daily.set(day, (daily.get(day) ?? 0) + e.creditConsumed);
}
const csv = ['Date,UserId,EnvironmentId,EnvironmentName,AIConsumption,IsTrial'];
for (const [day, credits] of [...daily.entries()].sort()) {
  csv.push(`${day},99999999-0000-0000-0000-000000000001,ffffffff-0000-0000-0000-0000000000aa,Contoso Demo Prod,${credits},FALSE`);
}
csv.push(`${CURRENT_MONTH}-05,99999999-0000-0000-0000-000000000002,ffffffff-0000-0000-0000-0000000000aa,Contoso Demo Prod,7777,TRUE`);
const csvFile = resolve(outDir, 'demo-ppac-prod.csv');
writeFileSync(csvFile, csv.join('\n') + '\n');
console.log(`wrote synthetic PPAC report -> ${csvFile}`);

// Lagging variant: PPAC computation can trail 5+ days, so drop the last 3 recorded
// days -> validate flags the delta. Use it to demo what a FLAGGED reconciliation
// looks like and why closed months are compared:
//   node dist/cli.js --data-dir ./data-demo validate --csv ./data-demo/demo-ppac-prod-lagging.csv \
//        --environment https://contoso-demo-prod.crm.dynamics.com
const days = [...daily.keys()].sort();
const lagged = new Set(days.slice(-3));
const csvLag = ['Date,UserId,EnvironmentId,EnvironmentName,AIConsumption,IsTrial'];
for (const [day, credits] of [...daily.entries()].sort()) {
  if (lagged.has(day)) continue;
  csvLag.push(`${day},99999999-0000-0000-0000-000000000001,ffffffff-0000-0000-0000-0000000000aa,Contoso Demo Prod,${credits},FALSE`);
}
const csvLagFile = resolve(outDir, 'demo-ppac-prod-lagging.csv');
writeFileSync(csvLagFile, csvLag.join('\n') + '\n');
console.log(`wrote LAGGING synthetic PPAC report (last 3 days missing) -> ${csvLagFile}`);
console.log('\nNext:');
console.log('  node dist/cli.js --data-dir ./data-demo forecast');
console.log(`  node dist/cli.js --data-dir ./data-demo validate --csv ./data-demo/demo-ppac-prod.csv --environment ${PROD} --month ${CURRENT_MONTH}`);
