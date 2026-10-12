/** Currency a single AI event consumed. Explicit tags come from msdyn_eventdata;
 * inferred tags come from the documented consumption rules (see README §Currency rules). */
export type CurrencyTag = 'AIB' | 'CC' | 'inferred-AIB' | 'inferred-CC';

export type ConsumptionSource =
  | 'PowerAutomate'
  | 'PowerApps'
  | 'API'
  | 'CopilotStudio'
  | 'Unknown';

/** One row of the Dataverse AI Event table (msdyn_aievent), joined with its AI model. */
export interface RawAiEvent {
  id: string;
  name: string | null;
  processingDate: string; // ISO 8601 UTC
  processingStatus: number | null; // 0 Processed | 1 Failed | 2 Processing
  consumptionSource: number | null; // 0 PowerAutomation | 1 PowerApps | 2 API | 3 MCS
  creditConsumed: number;
  quickTest: boolean;
  modelName: string | null;
  templateName: string | null;
  /** Flow/app that triggered the run (msdyn_automationname), when recorded. */
  automationName: string | null;
  /** Creating user (createdby). For flow runs this is the executing identity —
   * often the flow/connection owner, not the human who triggered it. */
  userId: string | null;
  userName: string | null;
  eventData: string | null;
  environmentUrl: string;
}

/** Defensively-extracted fields from the msdyn_eventdata JSON payload. */
export interface ParsedEventData {
  currencyHint: 'AIB' | 'CC' | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  llmModelName: string | null;
  creditValue: number | null;
  parseError: boolean;
}

export interface TaggedEvent extends RawAiEvent {
  source: ConsumptionSource;
  currency: CurrencyTag;
  parsed: ParsedEventData;
}

export type RatingMethod =
  | 'eventdata-tokens' // exact token counts from msdyn_eventdata
  | 'rate-inversion' // units recovered from AIB credits / AIB rate
  | 'cc-passthrough' // event already denominated in Copilot Credits
  | 'free' // capability is free in both currencies
  | 'unmapped'; // AIB event with no capability match: excluded from forecast

export interface RatedEvent extends TaggedEvent {
  capabilityId: string | null;
  capabilityName: string | null;
  units: number | null;
  unitKind: string | null;
  /** Copilot Credits this event would cost after 2026-11-01. Null only for method 'unmapped'. */
  forecastCopilotCredits: number | null;
  method: RatingMethod;
}

export interface MonthlyAggregate {
  month: string; // YYYY-MM (UTC)
  events: number;
  aibCredits: number; // raw credits of AIB/inferred-AIB events
  ccCredits: number; // raw credits of CC/inferred-CC events
  forecastCopilotCredits: number;
  unmappedEvents: number;
  unmappedAibCredits: number;
}

export interface CapabilityAggregate {
  capabilityId: string;
  capabilityName: string;
  events: number;
  aibCredits: number;
  ccCredits: number;
  units: number;
  unitKind: string | null;
  forecastCopilotCredits: number;
  /** Effective CC-per-AIB-credit factor actually observed (forecast / AIB credits). */
  effectiveConversionFactor: number | null;
}

/** Consumption rolled up per flow/app/agent (msdyn_automationname). */
export interface FlowAggregate {
  automationName: string; // '(not recorded)' when the event has no automation name
  sources: string; // e.g. 'PowerAutomate' or 'PowerAutomate, PowerApps'
  events: number;
  aibCredits: number;
  ccCredits: number;
  forecastCopilotCredits: number;
  monthsActive: number;
  averageMonthlyCC: number;
  peakMonth: string | null;
  peakMonthCC: number;
}

/** Consumption rolled up per user (createdby identity). */
export interface UserAggregate {
  userId: string;
  userName: string;
  events: number;
  aibCredits: number;
  ccCredits: number;
  forecastCopilotCredits: number;
  monthsActive: number;
}

export interface DataWindow {
  from: string | null;
  to: string | null;
  monthsWithData: number;
  requestedMonths: number;
}

export interface EnvironmentSizing {
  environmentUrl: string;
  environmentName: string | null;
  environmentId: string | null;
  window: DataWindow;
  months: MonthlyAggregate[];
  capabilities: CapabilityAggregate[];
  flows: FlowAggregate[];
  users: UserAggregate[];
  peak: { month: string; forecastCopilotCredits: number; isPartialCurrentMonth: boolean } | null;
  bufferedCredits: number;
  packs: number;
}

export interface SizingResult {
  generatedAt: string;
  growthBuffer: number;
  packSizeCredits: number;
  environments: EnvironmentSizing[];
  tenant: {
    months: MonthlyAggregate[];
    peak: { month: string; forecastCopilotCredits: number; isPartialCurrentMonth: boolean } | null;
    bufferedCredits: number;
    packs: number;
    sumOfEnvironmentPacks: number;
  };
  unmapped: RatedEvent[];
  /** True when the forecast came from the PPAC CSV fallback (blended factor, no capability detail). */
  csvFallback: boolean;
  csvFallbackConversionFactor?: number;
  warnings: string[];
}

/** One row of the PPAC "AI Builder consumption report" export. */
export interface PpacRow {
  date: string; // ISO date
  userId: string | null;
  environmentId: string | null;
  environmentName: string | null;
  aiConsumption: number;
  isTrial: boolean;
}

export interface ValidationRow {
  environment: string;
  month: string;
  toolAibCredits: number;
  ppacAibCredits: number;
  deltaRatio: number | null; // (tool - ppac) / ppac
  flagged: boolean;
  note: string;
}

// ---- Rate table shapes (config/rate-tables/*.json) ----

export interface AibCapability {
  id: string;
  displayName: string;
  tier: string;
  unit: string;
  rateType: 'per-unit' | 'token-split' | 'free';
  ratePerUnit?: number;
  blendedRatePerUnit?: number;
  tokenRates?: { inputPer1K: number; outputPer1K: number };
  assumption?: string;
  notes?: string;
  match: { patterns: string[]; llmModelPatterns?: string[] };
}

export interface AibRateTable {
  version: string;
  currency: 'AIB';
  effectiveDate: string;
  retrievedDate: string;
  sourceUrl: string;
  notes?: string;
  capabilities: AibCapability[];
}

export interface CcFeature {
  id: string;
  displayName: string;
  unitDescription: string;
  ratePerUnit: number;
}

export interface CcRateTable {
  version: string;
  currency: 'CC';
  effectiveDate: string;
  retrievedDate: string;
  sourceUrls: string[];
  notes?: string;
  features: CcFeature[];
  capabilityToFeature: Record<string, string | null>;
}
