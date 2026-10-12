import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import dotenv from 'dotenv';
import type { AibRateTable, CcRateTable } from './types.js';

const environmentSchema = z.object({
  url: z.string().url(),
  environmentId: z.string().optional().default(''),
  name: z.string().optional().default(''),
});

const sizerConfigSchema = z.object({
  growthBuffer: z.number().min(0).max(5).default(0.2),
  packSizeCredits: z.number().int().positive().default(25000),
  monthsLookback: z.number().int().min(1).max(36).default(12),
  validationDeltaThreshold: z.number().min(0).max(1).default(0.05),
  excludeQuickTests: z.boolean().default(true),
  excludeFailedRuns: z.boolean().default(true),
  excludeTrialRows: z.boolean().default(true),
  numberLocale: z.string().default('en-US'),
  csvFallbackConversionFactor: z.number().positive().default(0.25),
  csvFallbackConversionFactorNote: z.string().optional(),
  consumptionEstimate: z
    .object({
      creditsPerSession: z.number().positive().nullable().default(null),
      note: z.string().optional(),
    })
    .default({ creditsPerSession: null }),
  environments: z.array(environmentSchema).default([]),
});

export type SizerConfig = z.infer<typeof sizerConfigSchema>;

export interface AuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret?: string;
  certPemPath?: string;
  certThumbprint?: string;
}

export interface EnvironmentRef {
  url: string;
  environmentId: string;
  name: string;
}

export type AuthMode = 'app' | 'azcli';

export interface LoadedConfig {
  config: SizerConfig;
  auth: AuthConfig | null;
  authMode: AuthMode;
  environments: EnvironmentRef[];
  packageRoot: string;
}

/** Package root = directory containing package.json (works from src/ via tsx and dist/ via node). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function loadConfig(configPath?: string): LoadedConfig {
  const root = packageRoot();
  dotenv.config({ path: resolve(root, '.env') });

  const file = configPath
    ? resolve(configPath)
    : resolve(root, 'config', 'sizer.config.json');
  if (!existsSync(file)) {
    throw new Error(`Config file not found: ${file}`);
  }
  const config = sizerConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

  // Merge environments: config file entries + ENVIRONMENT_URLS, unioned by URL.
  const byUrl = new Map<string, EnvironmentRef>();
  for (const e of config.environments) {
    const url = normalizeUrl(e.url);
    if (url.includes('yourorg')) continue; // skip placeholder
    byUrl.set(url.toLowerCase(), { url, environmentId: e.environmentId, name: e.name });
  }
  for (const raw of (process.env.ENVIRONMENT_URLS ?? '').split(',')) {
    const url = normalizeUrl(raw);
    if (!url || url.includes('yourorg')) continue;
    if (!byUrl.has(url.toLowerCase())) {
      byUrl.set(url.toLowerCase(), { url, environmentId: '', name: '' });
    }
  }

  const { TENANT_ID, CLIENT_ID, CLIENT_SECRET, CERT_PEM_PATH, CERT_THUMBPRINT, AUTH_MODE } = process.env;
  const authMode: AuthMode = AUTH_MODE?.trim().toLowerCase() === 'azcli' ? 'azcli' : 'app';
  let auth: AuthConfig | null = null;
  if (authMode === 'app' && TENANT_ID && CLIENT_ID && !TENANT_ID.startsWith('00000000')) {
    auth = {
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET || undefined,
      certPemPath: CERT_PEM_PATH ? resolve(root, CERT_PEM_PATH) : undefined,
      certThumbprint: CERT_THUMBPRINT || undefined,
    };
    if (!auth.clientSecret && !(auth.certPemPath && auth.certThumbprint)) {
      throw new Error(
        'Auth is configured but incomplete: set CLIENT_SECRET, or both CERT_PEM_PATH and CERT_THUMBPRINT.'
      );
    }
  }

  return { config, auth, authMode, environments: [...byUrl.values()], packageRoot: root };
}

const aibCapabilitySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  tier: z.string(),
  unit: z.string(),
  rateType: z.enum(['per-unit', 'token-split', 'free']),
  ratePerUnit: z.number().positive().optional(),
  blendedRatePerUnit: z.number().positive().optional(),
  tokenRates: z.object({ inputPer1K: z.number(), outputPer1K: z.number() }).optional(),
  assumption: z.string().optional(),
  notes: z.string().optional(),
  match: z.object({
    patterns: z.array(z.string()),
    llmModelPatterns: z.array(z.string()).optional(),
  }),
});

const aibRateTableSchema = z.object({
  version: z.string(),
  currency: z.literal('AIB'),
  effectiveDate: z.string(),
  retrievedDate: z.string(),
  sourceUrl: z.string().url(),
  notes: z.string().optional(),
  capabilities: z.array(aibCapabilitySchema).min(1),
});

const ccRateTableSchema = z.object({
  version: z.string(),
  currency: z.literal('CC'),
  effectiveDate: z.string(),
  retrievedDate: z.string(),
  sourceUrls: z.array(z.string().url()).min(1),
  notes: z.string().optional(),
  features: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string(),
        unitDescription: z.string(),
        ratePerUnit: z.number().positive(),
      })
    )
    .min(1),
  capabilityToFeature: z.record(z.string().nullable()),
});

export function loadRateTables(root?: string): { aib: AibRateTable; cc: CcRateTable } {
  const base = resolve(root ?? packageRoot(), 'config', 'rate-tables');
  const aib = aibRateTableSchema.parse(
    JSON.parse(readFileSync(resolve(base, 'aibuilder-rates.json'), 'utf8'))
  ) as AibRateTable;
  const cc = ccRateTableSchema.parse(
    JSON.parse(readFileSync(resolve(base, 'copilot-credit-rates.json'), 'utf8'))
  ) as CcRateTable;

  // Integrity: every non-free AIB capability must have a rate and a CC mapping entry.
  for (const cap of aib.capabilities) {
    if (cap.rateType === 'per-unit' && cap.ratePerUnit === undefined) {
      throw new Error(`Rate table error: capability '${cap.id}' is per-unit but has no ratePerUnit.`);
    }
    if (cap.rateType === 'token-split' && (!cap.tokenRates || cap.blendedRatePerUnit === undefined)) {
      throw new Error(`Rate table error: capability '${cap.id}' is token-split but lacks tokenRates/blendedRatePerUnit.`);
    }
    if (cap.rateType !== 'free' && !(cap.id in cc.capabilityToFeature)) {
      throw new Error(`Rate table error: capability '${cap.id}' has no entry in copilot-credit-rates.json capabilityToFeature.`);
    }
    const feature = cc.capabilityToFeature[cap.id];
    if (feature && !cc.features.some((f) => f.id === feature)) {
      throw new Error(`Rate table error: capability '${cap.id}' maps to unknown feature '${feature}'.`);
    }
  }
  return { aib, cc };
}
