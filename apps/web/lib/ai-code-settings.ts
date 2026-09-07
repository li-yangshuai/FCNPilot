export type AiCodeReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AiCodeSettings {
  completionDelayMs: number;
  completionContextChars: number;
  completionMaxTokens: number;
  completionReasoning: AiCodeReasoningLevel;
  reviewDelayMs: number;
  reviewContextChars: number;
  reviewMaxTokens: number;
  reviewReasoning: AiCodeReasoningLevel;
}

export const DEFAULT_AI_CODE_SETTINGS: AiCodeSettings = {
  completionDelayMs: 90,
  completionContextChars: 44_000,
  completionMaxTokens: 1_024,
  completionReasoning: "off",
  reviewDelayMs: 1_600,
  reviewContextChars: 60_000,
  reviewMaxTokens: 3_072,
  reviewReasoning: "off",
};

export const AI_CODE_SETTING_LIMITS = {
  completionDelayMs: { min: 50, max: 5_000, step: 10 },
  completionContextChars: { min: 8_000, max: 200_000, step: 1_000 },
  completionMaxTokens: { min: 128, max: 16_384, step: 128 },
  reviewDelayMs: { min: 300, max: 30_000, step: 100 },
  reviewContextChars: { min: 10_000, max: 300_000, step: 1_000 },
  reviewMaxTokens: { min: 512, max: 32_768, step: 256 },
} as const;

const REASONING_LEVELS = new Set<AiCodeReasoningLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function reasoningLevel(value: unknown, fallback: AiCodeReasoningLevel): AiCodeReasoningLevel {
  return typeof value === "string" && REASONING_LEVELS.has(value as AiCodeReasoningLevel)
    ? value as AiCodeReasoningLevel
    : fallback;
}

export function normalizeAiCodeSettings(value: unknown): AiCodeSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    completionDelayMs: boundedNumber(raw.completionDelayMs, DEFAULT_AI_CODE_SETTINGS.completionDelayMs, AI_CODE_SETTING_LIMITS.completionDelayMs.min, AI_CODE_SETTING_LIMITS.completionDelayMs.max),
    completionContextChars: boundedNumber(raw.completionContextChars, DEFAULT_AI_CODE_SETTINGS.completionContextChars, AI_CODE_SETTING_LIMITS.completionContextChars.min, AI_CODE_SETTING_LIMITS.completionContextChars.max),
    completionMaxTokens: boundedNumber(raw.completionMaxTokens, DEFAULT_AI_CODE_SETTINGS.completionMaxTokens, AI_CODE_SETTING_LIMITS.completionMaxTokens.min, AI_CODE_SETTING_LIMITS.completionMaxTokens.max),
    completionReasoning: reasoningLevel(raw.completionReasoning, DEFAULT_AI_CODE_SETTINGS.completionReasoning),
    reviewDelayMs: boundedNumber(raw.reviewDelayMs, DEFAULT_AI_CODE_SETTINGS.reviewDelayMs, AI_CODE_SETTING_LIMITS.reviewDelayMs.min, AI_CODE_SETTING_LIMITS.reviewDelayMs.max),
    reviewContextChars: boundedNumber(raw.reviewContextChars, DEFAULT_AI_CODE_SETTINGS.reviewContextChars, AI_CODE_SETTING_LIMITS.reviewContextChars.min, AI_CODE_SETTING_LIMITS.reviewContextChars.max),
    reviewMaxTokens: boundedNumber(raw.reviewMaxTokens, DEFAULT_AI_CODE_SETTINGS.reviewMaxTokens, AI_CODE_SETTING_LIMITS.reviewMaxTokens.min, AI_CODE_SETTING_LIMITS.reviewMaxTokens.max),
    reviewReasoning: reasoningLevel(raw.reviewReasoning, DEFAULT_AI_CODE_SETTINGS.reviewReasoning),
  };
}
