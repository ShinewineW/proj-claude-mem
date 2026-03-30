import { describe, expect, it, mock } from 'bun:test';
import type { ActiveSession, SDKUsageMessageKind } from '../../src/services/worker-types.js';
import {
  createSDKUsageTotals,
  logSDKUsageSummary,
  recordSDKUsage,
} from '../../src/services/worker/SDKUsageTelemetry.js';

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 113,
    contentSessionId: 'content-session-113',
    memorySessionId: 'memory-session-113',
    project: 'ClaudeMem-ProjIso',
    userPrompt: 'debug token usage',
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 4,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    conversationHistory: [],
    currentProvider: 'claude',
    consecutiveRestarts: 0,
    contextResetCount: 0,
    lastGeneratorActivity: Date.now(),
    processingMessageIds: [],
    totalLifetimeCrashes: 0,
    consecutiveEmptyObservations: 0,
    peakConsecutiveEmptyObs: 0,
    totalPoolTimeouts: 0,
    lastResponseAt: null,
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: mock(() => {}),
  };
}

describe('SDK usage telemetry', () => {
  it('logs per-response SDK usage with message kind and cumulative totals', () => {
    const session = makeSession();
    const logger = makeLogger();

    const discoveryTokens = recordSDKUsage({
      session,
      promptNumber: 4,
      messageKind: 'observation',
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 40,
      },
      logger,
    });

    expect(discoveryTokens).toBe(200);
    expect(session.cumulativeInputTokens).toBe(170);
    expect(session.cumulativeOutputTokens).toBe(30);
    expect(session.cumulativeSDKUsage?.totalDiscoveryTokens).toBe(200);
    expect(session.cumulativeSDKUsage?.totalResponses).toBe(1);

    expect(logger.info).toHaveBeenCalledWith(
      'SDK',
      'SDK_USAGE',
      expect.objectContaining({
        usageChannel: 'claude_sdk_main',
        sessionDbId: 113,
        contentSessionId: 'content-session-113',
        memorySessionId: 'memory-session-113',
        promptNumber: 4,
        messageKind: 'observation',
        inputTokens: 120,
        outputTokens: 30,
        cacheCreationInputTokens: 50,
        cacheReadInputTokens: 40,
        reportedTotalTokens: 240,
        discoveryTokens: 200,
        cumulativeResponses: 1,
        cumulativeReportedTotalTokens: 240,
        cumulativeDiscoveryTokens: 200,
      }),
    );
  });

  it('logs a flattened session summary grouped by message kind', () => {
    const session = makeSession();
    const logger = makeLogger();

    const usageEntries: Array<{
      messageKind: SDKUsageMessageKind;
      promptNumber: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    }> = [
      {
        messageKind: 'init',
        promptNumber: 1,
        usage: {
          input_tokens: 90,
          output_tokens: 20,
        },
      },
      {
        messageKind: 'summarize',
        promptNumber: 4,
        usage: {
          input_tokens: 60,
          output_tokens: 10,
          cache_creation_input_tokens: 30,
        },
      },
    ];

    for (const entry of usageEntries) {
      recordSDKUsage({
        session,
        logger,
        promptNumber: entry.promptNumber,
        messageKind: entry.messageKind,
        usage: entry.usage,
      });
    }

    logSDKUsageSummary({
      session,
      logger,
      summaryType: 'session',
    });

    expect(logger.info).toHaveBeenCalledWith(
      'SDK',
      'SDK_USAGE_SUMMARY',
      expect.objectContaining({
        usageChannel: 'claude_sdk_main',
        summaryType: 'session',
        sessionDbId: 113,
        totalResponses: 2,
        totalInputTokens: 150,
        totalOutputTokens: 30,
        totalCacheCreationInputTokens: 30,
        totalCacheReadInputTokens: 0,
        totalReportedTokens: 210,
        totalDiscoveryTokens: 210,
        initResponses: 1,
        initDiscoveryTokens: 110,
        summarizeResponses: 1,
        summarizeDiscoveryTokens: 100,
      }),
    );
  });

  it('accumulates run totals independently of session totals', () => {
    const session = makeSession();
    const logger = makeLogger();
    const runTotals = createSDKUsageTotals();

    // First call: with separate runTotals
    recordSDKUsage({
      session,
      promptNumber: 1,
      messageKind: 'init',
      usage: { input_tokens: 100, output_tokens: 20 },
      logger,
      usageTotals: runTotals,
    });

    // Second call: without runTotals (falls back to session totals)
    recordSDKUsage({
      session,
      promptNumber: 2,
      messageKind: 'observation',
      usage: { input_tokens: 50, output_tokens: 10 },
      logger,
    });

    // Run totals only have the first call
    expect(runTotals.totalResponses).toBe(1);
    expect(runTotals.totalInputTokens).toBe(100);
    expect(runTotals.totalOutputTokens).toBe(20);

    // Session totals have both calls
    expect(session.cumulativeSDKUsage?.totalResponses).toBe(2);
    expect(session.cumulativeSDKUsage?.totalInputTokens).toBe(150);
    expect(session.cumulativeSDKUsage?.totalOutputTokens).toBe(30);
  });

  it('does not double-count when usageTotals is omitted', () => {
    const session = makeSession();
    const logger = makeLogger();

    recordSDKUsage({
      session,
      promptNumber: 1,
      messageKind: 'init',
      usage: { input_tokens: 100, output_tokens: 20 },
      logger,
    });

    // Without separate usageTotals, session totals should be incremented exactly once
    expect(session.cumulativeSDKUsage?.totalResponses).toBe(1);
    expect(session.cumulativeSDKUsage?.totalInputTokens).toBe(100);
  });

  it('skips summary when no responses recorded', () => {
    const session = makeSession();
    const logger = makeLogger();

    logSDKUsageSummary({ session, logger, summaryType: 'session' });

    // cumulativeSDKUsage is undefined, should not log
    expect(logger.info).not.toHaveBeenCalled();
  });
});
