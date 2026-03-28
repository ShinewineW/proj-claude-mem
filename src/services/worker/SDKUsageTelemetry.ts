import { logger as defaultLogger } from "../../utils/logger.js";
import type {
  ActiveSession,
  SDKUsageKindTotals,
  SDKUsageMessageKind,
  SDKUsageTotals,
} from "../worker-types.js";

const SDK_USAGE_CHANNEL = "claude_sdk_main";
const SDK_USAGE_KINDS: SDKUsageMessageKind[] = [
  "init",
  "continuation",
  "observation",
  "summarize",
  "unknown",
];

interface ClaudeSDKUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface LoggerLike {
  info(
    component: "SDK",
    message: string,
    context?: Record<string, any>,
    data?: any,
  ): void;
}

interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  reportedTotalTokens: number;
  discoveryTokens: number;
}

interface RecordSDKUsageParams {
  session: ActiveSession;
  promptNumber: number;
  messageKind: SDKUsageMessageKind;
  usage: ClaudeSDKUsage;
  logger?: LoggerLike;
  usageTotals?: SDKUsageTotals;
}

interface LogSDKUsageSummaryParams {
  session: Pick<
    ActiveSession,
    | "sessionDbId"
    | "contentSessionId"
    | "memorySessionId"
    | "cumulativeSDKUsage"
    | "optimizationStats"
  >;
  logger?: LoggerLike;
  summaryType: "run" | "session";
  usageTotals?: SDKUsageTotals;
}

function createEmptyKindTotals(): SDKUsageKindTotals {
  return {
    responses: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reportedTotalTokens: 0,
    discoveryTokens: 0,
  };
}

export function createSDKUsageTotals(): SDKUsageTotals {
  const byKind = {} as SDKUsageTotals["byKind"];
  for (const kind of SDK_USAGE_KINDS) {
    byKind[kind] = createEmptyKindTotals();
  }

  return {
    totalResponses: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationInputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalReportedTokens: 0,
    totalDiscoveryTokens: 0,
    byKind,
  };
}

function normalizeMetric(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value > 0 ? value : 0;
}

function normalizeUsage(usage: ClaudeSDKUsage): UsageMetrics {
  const inputTokens = normalizeMetric(usage.input_tokens);
  const outputTokens = normalizeMetric(usage.output_tokens);
  const cacheCreationInputTokens = normalizeMetric(
    usage.cache_creation_input_tokens,
  );
  const cacheReadInputTokens = normalizeMetric(usage.cache_read_input_tokens);
  const discoveryTokens = inputTokens + outputTokens + cacheCreationInputTokens;

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    reportedTotalTokens: discoveryTokens + cacheReadInputTokens,
    discoveryTokens,
  };
}

function applyUsageTotals(
  totals: SDKUsageTotals,
  messageKind: SDKUsageMessageKind,
  metrics: UsageMetrics,
): void {
  totals.totalResponses += 1;
  totals.totalInputTokens += metrics.inputTokens;
  totals.totalOutputTokens += metrics.outputTokens;
  totals.totalCacheCreationInputTokens += metrics.cacheCreationInputTokens;
  totals.totalCacheReadInputTokens += metrics.cacheReadInputTokens;
  totals.totalReportedTokens += metrics.reportedTotalTokens;
  totals.totalDiscoveryTokens += metrics.discoveryTokens;

  const kindTotals = totals.byKind[messageKind];
  kindTotals.responses += 1;
  kindTotals.inputTokens += metrics.inputTokens;
  kindTotals.outputTokens += metrics.outputTokens;
  kindTotals.cacheCreationInputTokens += metrics.cacheCreationInputTokens;
  kindTotals.cacheReadInputTokens += metrics.cacheReadInputTokens;
  kindTotals.reportedTotalTokens += metrics.reportedTotalTokens;
  kindTotals.discoveryTokens += metrics.discoveryTokens;
}

function ensureSessionUsageTotals(session: ActiveSession): SDKUsageTotals {
  if (!session.cumulativeSDKUsage) {
    session.cumulativeSDKUsage = createSDKUsageTotals();
  }
  return session.cumulativeSDKUsage;
}

function buildSummaryKindFields(
  totals: SDKUsageTotals,
): Record<string, number> {
  const fields: Record<string, number> = {};

  for (const kind of SDK_USAGE_KINDS) {
    const kindTotals = totals.byKind[kind];
    fields[`${kind}Responses`] = kindTotals.responses;
    fields[`${kind}DiscoveryTokens`] = kindTotals.discoveryTokens;
    fields[`${kind}ReportedTokens`] = kindTotals.reportedTotalTokens;
  }

  return fields;
}

export function recordSDKUsage({
  session,
  promptNumber,
  messageKind,
  usage,
  logger = defaultLogger,
  usageTotals,
}: RecordSDKUsageParams): number {
  const metrics = normalizeUsage(usage);
  const sessionTotals = ensureSessionUsageTotals(session);
  const currentRunTotals = usageTotals ?? sessionTotals;

  // Update legacy cumulative counters (consumed by existing log lines)
  session.cumulativeInputTokens +=
    metrics.inputTokens + metrics.cacheCreationInputTokens;
  session.cumulativeOutputTokens += metrics.outputTokens;

  applyUsageTotals(sessionTotals, messageKind, metrics);
  if (currentRunTotals !== sessionTotals) {
    applyUsageTotals(currentRunTotals, messageKind, metrics);
  }

  logger.info("SDK", "SDK_USAGE", {
    usageChannel: SDK_USAGE_CHANNEL,
    sessionDbId: session.sessionDbId,
    contentSessionId: session.contentSessionId,
    memorySessionId: session.memorySessionId ?? "(none)",
    promptNumber,
    messageKind,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheCreationInputTokens: metrics.cacheCreationInputTokens,
    cacheReadInputTokens: metrics.cacheReadInputTokens,
    reportedTotalTokens: metrics.reportedTotalTokens,
    discoveryTokens: metrics.discoveryTokens,
    cumulativeResponses: sessionTotals.totalResponses,
    cumulativeInputTokens: sessionTotals.totalInputTokens,
    cumulativeOutputTokens: sessionTotals.totalOutputTokens,
    cumulativeCacheCreationInputTokens:
      sessionTotals.totalCacheCreationInputTokens,
    cumulativeCacheReadInputTokens: sessionTotals.totalCacheReadInputTokens,
    cumulativeReportedTotalTokens: sessionTotals.totalReportedTokens,
    cumulativeDiscoveryTokens: sessionTotals.totalDiscoveryTokens,
  });

  return metrics.discoveryTokens;
}

export function logSDKUsageSummary({
  session,
  logger = defaultLogger,
  summaryType,
  usageTotals,
}: LogSDKUsageSummaryParams): void {
  const totals = usageTotals ?? session.cumulativeSDKUsage;
  if (!totals || totals.totalResponses === 0) return;

  logger.info("SDK", "SDK_USAGE_SUMMARY", {
    usageChannel: SDK_USAGE_CHANNEL,
    summaryType,
    sessionDbId: session.sessionDbId,
    contentSessionId: session.contentSessionId,
    memorySessionId: session.memorySessionId ?? "(none)",
    totalResponses: totals.totalResponses,
    totalInputTokens: totals.totalInputTokens,
    totalOutputTokens: totals.totalOutputTokens,
    totalCacheCreationInputTokens: totals.totalCacheCreationInputTokens,
    totalCacheReadInputTokens: totals.totalCacheReadInputTokens,
    totalReportedTokens: totals.totalReportedTokens,
    totalDiscoveryTokens: totals.totalDiscoveryTokens,
    ...buildSummaryKindFields(totals),
    // Phase 1 optimization counters
    ...(session.optimizationStats
      ? {
          optBatchedObservations: session.optimizationStats.batchedObservations,
          optBatchPromptsSaved: session.optimizationStats.batchPromptsSaved,
          optTotalPromptChars: session.optimizationStats.totalPromptChars,
        }
      : {}),
  });
}
