#!/usr/bin/env node
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Command } from 'commander';
import { loadConfig, loadRateTables, type LoadedConfig } from './config.js';
import { createAzCliTokenProvider, createTokenProvider } from './auth/token.js';
import { fetchAiEvents } from './ingest/dataverse.js';
import { parsePpacReport } from './ingest/ppac-report.js';
import { tagEvent } from './domain/currency-tagger.js';
import { RateMapper } from './domain/rate-mapper.js';
import { computeSizing, computeSizingFromPpac } from './domain/sizing.js';
import { comparePpac } from './validate/ppac-compare.js';
import { writeXlsxReport } from './report/xlsx.js';
import { renderMarkdownReport } from './report/markdown.js';
import { printSizingSummary, printValidation } from './report/console.js';
import { monthKey } from './domain/aggregate.js';
import type { RatedEvent, TaggedEvent } from './types.js';

interface CacheFile {
  meta: {
    environmentUrl: string;
    retrievedAt: string;
    sinceIso: string;
    eventCount: number;
  };
  events: TaggedEvent[];
}

function envFileName(environmentUrl: string): string {
  return `${new URL(environmentUrl).host.replace(/[^a-z0-9.-]/gi, '-')}.json`;
}

function selectEnvironments(loaded: LoadedConfig, only?: string) {
  if (!only) return loaded.environments;
  const norm = only.trim().replace(/\/+$/, '').toLowerCase();
  const matched = loaded.environments.filter((e) => e.url.toLowerCase() === norm);
  // Allow ad-hoc URLs not present in config for the one-environment-first workflow.
  if (matched.length === 0 && /^https:\/\//i.test(only)) {
    return [{ url: only.trim().replace(/\/+$/, ''), environmentId: '', name: '' }];
  }
  if (matched.length === 0) {
    throw new Error(`--environment '${only}' not found in config/.env and is not a URL.`);
  }
  return matched;
}

function loadCache(dataDir: string, only?: string): Map<string, TaggedEvent[]> {
  if (!existsSync(dataDir)) {
    throw new Error(`Data directory not found: ${dataDir}. Run 'sizer ingest' first.`);
  }
  const map = new Map<string, TaggedEvent[]>();
  const filter = only ? envFileName(only.trim().replace(/\/+$/, '')) : null;
  for (const file of readdirSync(dataDir).filter((f) => f.endsWith('.json'))) {
    if (filter && file !== filter) continue;
    const cache = JSON.parse(readFileSync(join(dataDir, file), 'utf8')) as CacheFile;
    map.set(cache.meta.environmentUrl, cache.events);
  }
  if (map.size === 0) {
    throw new Error(
      `No ingested data found in ${dataDir}${only ? ` for ${only}` : ''}. Run 'sizer ingest' first.`
    );
  }
  return map;
}

function rateAll(events: Map<string, TaggedEvent[]>, root: string): Map<string, RatedEvent[]> {
  const { aib, cc } = loadRateTables(root);
  const mapper = new RateMapper(aib, cc);
  const rated = new Map<string, RatedEvent[]>();
  for (const [url, list] of events) {
    rated.set(url, list.map((e) => mapper.rateEvent(e)));
  }
  return rated;
}

const program = new Command();
program
  .name('sizer')
  .description(
    'Sizes the Copilot Credit purchase replacing retiring seeded AI Builder credits (EOL 2026-11-01), from actual usage.'
  )
  .option('--config <path>', 'path to sizer.config.json (default: config/sizer.config.json)')
  .option('--data-dir <path>', 'ingested-data cache directory (default: ./data)')
  .option('--out-dir <path>', 'report output directory (default: ./output)');

program
  .command('ingest')
  .description('Pull AI events (msdyn_aievents) from Dataverse into the local data cache. Read-only.')
  .option('--environment <url>', 'ingest a single environment only')
  .option('--auth <mode>', "auth mode: 'app' (client credentials) or 'azcli' (delegated, no app registration)")
  .action(async (options: { environment?: string; auth?: string }) => {
    const loaded = loadConfig(program.opts().config);
    const authMode = options.auth?.trim().toLowerCase() === 'azcli' ? 'azcli' : loaded.authMode;
    if (authMode === 'app' && !loaded.auth) {
      throw new Error(
        'No auth configured. Either fill TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env (app mode), ' +
          "or run with --auth azcli after 'az login' (no app registration; requires read access to the environments, " +
          'e.g. a Power Platform admin self-elevated to System Administrator).'
      );
    }
    const environments = selectEnvironments(loaded, options.environment);
    if (environments.length === 0) {
      throw new Error('No environments configured. Set ENVIRONMENT_URLS in .env or "environments" in config.');
    }
    const dataDir = resolve(program.opts().dataDir ?? join(loaded.packageRoot, 'data'));
    mkdirSync(dataDir, { recursive: true });

    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - loaded.config.monthsLookback);
    since.setUTCDate(1);
    since.setUTCHours(0, 0, 0, 0);
    const sinceIso = since.toISOString();
    const tokenProvider =
      authMode === 'azcli' ? createAzCliTokenProvider() : createTokenProvider(loaded.auth!);
    if (authMode === 'azcli') {
      console.log('Auth: Azure CLI delegated tokens (running as the signed-in az user).');
    }

    interface IngestResult {
      url: string;
      status: 'OK' | 'FAILED';
      events: number;
      from?: string;
      to?: string;
      error?: string;
    }
    const results: IngestResult[] = [];
    const total = environments.length;

    for (const [index, env] of environments.entries()) {
      console.log(`[${index + 1}/${total}] Ingesting ${env.url} (since ${sinceIso.slice(0, 10)}) ...`);
      try {
        const raw = await fetchAiEvents(env.url, tokenProvider, sinceIso, (n) =>
          process.stdout.write(`\r  fetched ${n} events`)
        );
        process.stdout.write('\n');
        const events = raw.map(tagEvent);
        const cache: CacheFile = {
          meta: {
            environmentUrl: env.url,
            retrievedAt: new Date().toISOString(),
            sinceIso,
            eventCount: events.length,
          },
          events,
        };
        const file = join(dataDir, envFileName(env.url));
        writeFileSync(file, JSON.stringify(cache));
        const dates = events.map((e) => e.processingDate).sort();
        const from = dates[0]?.slice(0, 10);
        const to = dates[dates.length - 1]?.slice(0, 10);
        console.log(
          `  ${events.length} events cached → ${file}` +
            (events.length > 0
              ? `\n  actual data window: ${from} → ${to}`
              : '\n  note: 0 events — environment has no AI Builder/prompt usage in the window.')
        );
        results.push({ url: env.url, status: 'OK', events: events.length, from, to });
      } catch (error: unknown) {
        const message = (error instanceof Error ? error.message : String(error))
          .replace(/\s+/g, ' ')
          .slice(0, 300);
        const hint = /403|prvRead|not been assigned any roles/i.test(message)
          ? ' [ACCESS: signed-in user has no role here — self-elevate to System Administrator in PPAC, then re-run this environment]'
          : '';
        console.error(`  FAILED: ${message}${hint}`);
        results.push({ url: env.url, status: 'FAILED', events: 0, error: message + hint });
      }
    }

    // ---- run summary + persistent log ----
    const ok = results.filter((r) => r.status === 'OK');
    const failed = results.filter((r) => r.status === 'FAILED');
    console.log(
      `\nIngest summary: ${ok.length}/${total} environments OK ` +
        `(${ok.reduce((sum, r) => sum + r.events, 0)} events, ${ok.filter((r) => r.events > 0).length} with data), ${failed.length} failed.`
    );
    if (failed.length > 0) {
      console.log('Failed environments (fix access, then re-run each with --environment <url>):');
      for (const r of failed) console.log(`  - ${r.url}`);
    }
    const logFile = join(dataDir, 'ingest-log.csv');
    if (!existsSync(logFile)) {
      writeFileSync(logFile, 'timestamp,environment,status,events,windowFrom,windowTo,error\n');
    }
    const stamp = new Date().toISOString();
    appendFileSync(
      logFile,
      results
        .map((r) =>
          [stamp, r.url, r.status, r.events, r.from ?? '', r.to ?? '', (r.error ?? '').replaceAll('"', "'")]
            .map((v) => `"${v}"`)
            .join(',')
        )
        .join('\n') + '\n'
    );
    console.log(`Log: ${logFile}`);
    if (ok.length === 0 && total > 0) process.exitCode = 1;
  });

program
  .command('forecast')
  .description('Re-rate all consumption into Copilot Credits, size peak month + buffer, write reports.')
  .option('--environment <url>', 'forecast a single environment only')
  .option('--csv <path>', 'FALLBACK: forecast from a PPAC AI Builder consumption report export instead of Dataverse data')
  .action(async (options: { environment?: string; csv?: string }) => {
    const loaded = loadConfig(program.opts().config);
    const outDir = resolve(program.opts().outDir ?? join(loaded.packageRoot, 'output'));
    mkdirSync(outDir, { recursive: true });

    let result;
    if (options.csv) {
      const rows = await parsePpacReport(resolve(options.csv));
      const byEnv = new Map<string, Map<string, number>>();
      for (const row of rows) {
        if (loaded.config.excludeTrialRows && row.isTrial) continue;
        const envKey = row.environmentName || row.environmentId || '(unknown environment)';
        if (!byEnv.has(envKey)) byEnv.set(envKey, new Map());
        const months = byEnv.get(envKey)!;
        const month = monthKey(row.date);
        months.set(month, (months.get(month) ?? 0) + row.aiConsumption);
      }
      result = computeSizingFromPpac(byEnv, loaded.config);
      // PPAC rows carry a UserId (AAD object id, no display name) — surface per-user
      // AIB totals in CSV-fallback mode too.
      const factor = loaded.config.csvFallbackConversionFactor;
      for (const env of result.environments) {
        const byUser = new Map<string, { credits: number; runs: number; months: Set<string>; email: string | null }>();
        for (const row of rows) {
          if (loaded.config.excludeTrialRows && row.isTrial) continue;
          const envKey = row.environmentName || row.environmentId || '(unknown environment)';
          if (envKey !== env.environmentUrl) continue;
          const uid = row.userId ?? row.userEmail ?? '(not recorded)';
          let acc = byUser.get(uid);
          if (!acc) {
            acc = { credits: 0, runs: 0, months: new Set(), email: row.userEmail };
            byUser.set(uid, acc);
          }
          if (!acc.email && row.userEmail) acc.email = row.userEmail;
          acc.credits += row.aiConsumption;
          acc.runs += 1;
          acc.months.add(monthKey(row.date));
        }
        env.users = [...byUser.entries()]
          .map(([uid, a]) => ({
            userId: uid,
            userName: a.email ?? uid, // newer PPAC schema carries user emails
            events: a.runs,
            aibCredits: a.credits,
            ccCredits: 0,
            forecastCopilotCredits: a.credits * factor,
            monthsActive: a.months.size,
          }))
          .sort((a, b) => b.forecastCopilotCredits - a.forecastCopilotCredits);
      }
    } else {
      const dataDir = resolve(program.opts().dataDir ?? join(loaded.packageRoot, 'data'));
      const cached = loadCache(dataDir, options.environment);
      const rated = rateAll(cached, loaded.packageRoot);
      result = computeSizing(rated, loaded.environments, loaded.config);
    }

    const xlsxPath = join(outDir, 'sizing-report.xlsx');
    const mdPath = join(outDir, 'sizing-report.md');
    await writeXlsxReport(result, xlsxPath);
    writeFileSync(mdPath, renderMarkdownReport(result, loaded.config.numberLocale), 'utf8');
    printSizingSummary(result, loaded.config.numberLocale);
    console.log(`  Reports written:\n   - ${xlsxPath}\n   - ${mdPath}`);
  });

program
  .command('consumption')
  .description(
    'Per-agent consumption view (sessions + AI-tool credits, per month). Replacement for the retired per-agent licensing endpoint — supported surfaces only, read-only.'
  )
  .requiredOption('--environment <url>', 'environment to report on')
  .option('--auth <mode>', "auth mode: 'app' or 'azcli' (delegated, no app registration)")
  .option('--months <n>', 'lookback in months (default: config monthsLookback)')
  .action(async (options: { environment: string; auth?: string; months?: string }) => {
    const { fetchAgents, fetchTranscriptSessions } = await import('./ingest/transcripts.js');
    const { buildAgentConsumption } = await import('./domain/agent-consumption.js');
    const { printAgentConsumption, renderAgentConsumptionMarkdown, renderAgentConsumptionCsv } =
      await import('./report/consumption.js');

    const loaded = loadConfig(program.opts().config);
    const authMode = options.auth?.trim().toLowerCase() === 'azcli' ? 'azcli' : loaded.authMode;
    if (authMode === 'app' && !loaded.auth) {
      throw new Error("No auth configured. Fill .env (app mode) or run with --auth azcli after 'az login'.");
    }
    const envUrl = options.environment.trim().replace(/\/+$/, '');
    const months = options.months ? Number(options.months) : loaded.config.monthsLookback;
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - months);
    since.setUTCDate(1);
    since.setUTCHours(0, 0, 0, 0);

    const tokenProvider =
      authMode === 'azcli' ? createAzCliTokenProvider() : createTokenProvider(loaded.auth!);
    const token = await tokenProvider(envUrl);

    console.log(`Agents (bot table) ...`);
    const agents = await fetchAgents(envUrl, token);
    console.log(`  ${agents.length} agent(s) found`);
    console.log(`Conversation sessions since ${since.toISOString().slice(0, 10)} (metadata only, no content) ...`);
    const { sessions, attributed } = await fetchTranscriptSessions(
      envUrl, token, since.toISOString(), (n) => process.stdout.write(`\r  fetched ${n} sessions`)
    );
    process.stdout.write(`\r  ${sessions.length} sessions fetched\n`);

    // MCS-source AI-tool credits from the existing ingest cache (if present).
    const dataDir = resolve(program.opts().dataDir ?? join(loaded.packageRoot, 'data'));
    let mcsRated: RatedEvent[] = [];
    try {
      const cached = loadCache(dataDir, envUrl);
      const rated = rateAll(cached, loaded.packageRoot);
      const { filterCountableEvents } = await import('./domain/aggregate.js');
      mcsRated = filterCountableEvents([...rated.values()].flat(), loaded.config).filter(
        (e) => e.source === 'CopilotStudio'
      );
    } catch {
      console.log('  (no ingest cache for this environment — AI-tool credits omitted; run `sizer ingest` first for the full view)');
    }

    const result = buildAgentConsumption(
      envUrl, agents, sessions, attributed, mcsRated,
      loaded.config.consumptionEstimate.creditsPerSession
    );

    const outDir = resolve(program.opts().outDir ?? join(loaded.packageRoot, 'output'));
    mkdirSync(outDir, { recursive: true });
    const mdPath = join(outDir, 'consumption-report.md');
    const csvPath = join(outDir, 'consumption-report.csv');
    writeFileSync(mdPath, renderAgentConsumptionMarkdown(result, loaded.config.numberLocale), 'utf8');
    writeFileSync(csvPath, renderAgentConsumptionCsv(result), 'utf8');
    printAgentConsumption(result, loaded.config.numberLocale);
    console.log(`  Reports written:\n   - ${mdPath}\n   - ${csvPath}`);
  });

program
  .command('validate')
  .description("Compare the tool's AI Builder credit totals against the PPAC consumption report.")
  .requiredOption('--csv <path>', 'PPAC AI Builder consumption report export (.csv or .xlsx)')
  .option('--environment <url>', 'validate a single environment only')
  .option('--month <YYYY-MM>', 'calendar month to compare (default: current month)')
  .action(async (options: { csv: string; environment?: string; month?: string }) => {
    const loaded = loadConfig(program.opts().config);
    const dataDir = resolve(program.opts().dataDir ?? join(loaded.packageRoot, 'data'));
    const cached = loadCache(dataDir, options.environment);
    const rated = rateAll(cached, loaded.packageRoot);
    const rows = await parsePpacReport(resolve(options.csv));
    const month = options.month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`--month must be YYYY-MM, got '${month}'.`);

    const validation = comparePpac(rated, rows, loaded.environments, loaded.config, month);
    printValidation(validation, loaded.config.numberLocale, loaded.config.validationDeltaThreshold);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
