import type {
  AibCapability,
  AibRateTable,
  CcRateTable,
  RatedEvent,
  TaggedEvent,
} from '../types.js';
import { isCopilotCurrency } from './currency-tagger.js';

interface CompiledCapability {
  capability: AibCapability;
  patterns: RegExp[];
  llmPatterns: RegExp[];
}

/**
 * Maps tagged events to AI Builder capabilities and re-rates them into Copilot
 * Credits. All rates come from the two config/rate-tables JSON files; nothing
 * is hardcoded here.
 *
 * Forecast method per event:
 * - Already Copilot Credits (CC / inferred-CC): pass through unchanged.
 * - AIB with token counts in eventdata (prompts): totalTokens/1000 x CC rate.
 * - AIB otherwise: units = credits / AIB rate (inversion), then units x CC rate.
 * - Free capabilities: 0.
 * - No capability match on an AIB event: 'unmapped' (excluded from the forecast
 *   total, reported separately — never silently dropped, never guessed).
 */
export class RateMapper {
  private readonly compiled: CompiledCapability[];
  private readonly promptCapabilities: CompiledCapability[];

  constructor(
    private readonly aib: AibRateTable,
    private readonly cc: CcRateTable
  ) {
    this.compiled = aib.capabilities.map((capability) => ({
      capability,
      patterns: capability.match.patterns.map((p) => new RegExp(p, 'i')),
      llmPatterns: (capability.match.llmModelPatterns ?? []).map((p) => new RegExp(p, 'i')),
    }));
    this.promptCapabilities = this.compiled.filter((c) => c.capability.rateType === 'token-split');
  }

  ccRatePerUnit(capabilityId: string): number {
    const featureId = this.cc.capabilityToFeature[capabilityId];
    if (!featureId) return 0; // mapped to null => free on the CC side
    const feature = this.cc.features.find((f) => f.id === featureId);
    if (!feature) throw new Error(`No CC feature '${featureId}' for capability '${capabilityId}'.`);
    return feature.ratePerUnit;
  }

  /** First capability (in rate-table order) whose pattern matches the event's haystack. */
  matchCapability(event: TaggedEvent): AibCapability | null {
    const haystack = [event.templateName, event.modelName, event.name, event.parsed.llmModelName]
      .filter((v): v is string => Boolean(v))
      .join(' | ');
    if (!haystack) return null;

    for (const entry of this.compiled) {
      if (entry.patterns.some((p) => p.test(haystack))) {
        if (entry.capability.rateType === 'token-split') {
          return this.resolvePromptTier(event);
        }
        return entry.capability;
      }
    }
    return null;
  }

  /**
   * Prompt tier is decided by the LLM model name from eventdata against each
   * prompt capability's llmModelPatterns (premium checked first, then standard).
   * Unresolvable models default to basic — Microsoft's documented default tier.
   */
  private resolvePromptTier(event: TaggedEvent): AibCapability {
    const llm = event.parsed.llmModelName ?? '';
    const byTier = (tier: string) =>
      this.promptCapabilities.find((c) => c.capability.tier.toLowerCase() === tier);
    const premium = byTier('premium');
    const standard = byTier('standard');
    const basic = byTier('basic');
    if (!basic) throw new Error('Rate table must define a basic prompt capability.');

    if (llm) {
      if (premium && premium.llmPatterns.some((p) => p.test(llm))) return premium.capability;
      if (standard && standard.llmPatterns.some((p) => p.test(llm))) return standard.capability;
    }
    return basic.capability;
  }

  rateEvent(event: TaggedEvent): RatedEvent {
    const capability = this.matchCapability(event);
    const alreadyCC = isCopilotCurrency(event.currency);

    if (!capability) {
      if (alreadyCC) {
        // No guessing involved: the event is already denominated in Copilot Credits.
        return {
          ...event,
          capabilityId: null,
          capabilityName: null,
          units: null,
          unitKind: null,
          forecastCopilotCredits: event.creditConsumed,
          method: 'cc-passthrough',
        };
      }
      return {
        ...event,
        capabilityId: null,
        capabilityName: null,
        units: null,
        unitKind: null,
        forecastCopilotCredits: null,
        method: 'unmapped',
      };
    }

    const base = {
      ...event,
      capabilityId: capability.id,
      capabilityName: capability.displayName,
      unitKind: capability.unit,
    };

    if (capability.rateType === 'free') {
      return { ...base, units: null, forecastCopilotCredits: 0, method: 'free' };
    }

    if (alreadyCC) {
      return {
        ...base,
        units: null,
        forecastCopilotCredits: event.creditConsumed,
        method: 'cc-passthrough',
      };
    }

    const ccRate = this.ccRatePerUnit(capability.id);

    if (capability.rateType === 'token-split') {
      const { inputTokens, outputTokens, totalTokens } = event.parsed;
      const tokens =
        inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : totalTokens;
      if (tokens !== null && tokens > 0) {
        const units = tokens / 1000;
        return {
          ...base,
          units,
          forecastCopilotCredits: units * ccRate,
          method: 'eventdata-tokens',
        };
      }
      const blended = capability.blendedRatePerUnit;
      if (!blended) throw new Error(`Capability '${capability.id}' lacks blendedRatePerUnit.`);
      const units = event.creditConsumed / blended;
      return { ...base, units, forecastCopilotCredits: units * ccRate, method: 'rate-inversion' };
    }

    const aibRate = capability.ratePerUnit;
    if (!aibRate) throw new Error(`Capability '${capability.id}' lacks ratePerUnit.`);
    const units = event.creditConsumed / aibRate;
    return { ...base, units, forecastCopilotCredits: units * ccRate, method: 'rate-inversion' };
  }
}
