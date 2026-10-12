import type { ParsedEventData } from '../types.js';

const EMPTY: ParsedEventData = {
  currencyHint: null,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  llmModelName: null,
  creditValue: null,
  parseError: false,
};

const CURRENCY_KEYS = [
  'currency',
  'creditcurrency',
  'credittype',
  'creditkind',
  'billingtype',
  'billingcurrency',
  'licensetype',
  'consumptioncurrency',
  'consumptiontype',
  'entitlementtype',
];
const INPUT_TOKEN_KEYS = ['inputtokens', 'prompttokens', 'inputtokencount', 'input_token_count'];
const OUTPUT_TOKEN_KEYS = ['outputtokens', 'completiontokens', 'outputtokencount', 'output_token_count'];
const TOTAL_TOKEN_KEYS = ['totaltokens', 'totaltokencount', 'total_token_count', 'tokens'];
const LLM_KEYS = ['llmmodel', 'llmmodelname', 'aoaimodel', 'aoaimodelname', 'deploymentname', 'modelname', 'model'];
const CREDIT_KEYS = ['creditsconsumed', 'creditconsumed', 'creditvalue', 'credits', 'creditamount'];

function classifyCurrency(value: unknown): 'AIB' | 'CC' | null {
  if (typeof value !== 'string') return null;
  if (/copilot/i.test(value) || /^cc$/i.test(value.trim())) return 'CC';
  if (/ai\s*builder/i.test(value) || /^aib$/i.test(value.trim())) return 'AIB';
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * Defensive extraction from the msdyn_eventdata memo column. The payload shape is
 * undocumented and varies by capability, so this walks the JSON (depth-limited),
 * matches known key aliases case-insensitively, and never throws.
 */
export function parseEventData(text: string | null | undefined): ParsedEventData {
  if (!text || !text.trim()) return { ...EMPTY };

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { ...EMPTY, parseError: true };
  }

  const result: ParsedEventData = { ...EMPTY };

  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [rawKey, value] of Object.entries(node as Record<string, unknown>)) {
      const key = rawKey.toLowerCase().replace(/[^a-z0-9_]/g, '');

      if (result.currencyHint === null && CURRENCY_KEYS.includes(key)) {
        result.currencyHint = classifyCurrency(value);
      }
      if (result.currencyHint === null && key === 'iscopilotcredit' && value === true) {
        result.currencyHint = 'CC';
      }
      if (result.inputTokens === null && INPUT_TOKEN_KEYS.includes(key)) {
        result.inputTokens = toNumber(value);
      }
      if (result.outputTokens === null && OUTPUT_TOKEN_KEYS.includes(key)) {
        result.outputTokens = toNumber(value);
      }
      if (result.totalTokens === null && TOTAL_TOKEN_KEYS.includes(key)) {
        result.totalTokens = toNumber(value);
      }
      if (result.llmModelName === null && LLM_KEYS.includes(key) && typeof value === 'string' && value.trim()) {
        result.llmModelName = value.trim();
      }
      if (result.creditValue === null && CREDIT_KEYS.includes(key)) {
        result.creditValue = toNumber(value);
      }
      if (typeof value === 'object' && value !== null) visit(value, depth + 1);
    }
  };
  visit(root, 0);

  if (result.totalTokens === null && result.inputTokens !== null && result.outputTokens !== null) {
    result.totalTokens = result.inputTokens + result.outputTokens;
  }
  return result;
}
