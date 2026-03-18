import { describe, it, expect } from 'bun:test';

/**
 * Tests for SessionEventBroadcaster SSE event payloads.
 *
 * Verifies that session lifecycle events (started, completed) include
 * the project name in their broadcast payload, enabling the viewer
 * dashboard to update project cards without polling.
 */

// Minimal mock matching SSEBroadcaster.broadcast() signature
function createMockBroadcaster() {
  const broadcasts: any[] = [];
  return {
    broadcasts,
    broadcast: (event: any) => broadcasts.push(event),
  };
}

// Minimal mock matching WorkerService.broadcastProcessingStatus() signature
function createMockWorkerService() {
  return {
    broadcastProcessingStatus: () => {},
  };
}

describe('SessionEventBroadcaster', () => {
  it('broadcastSessionStarted includes project name in SSE payload', async () => {
    const { SessionEventBroadcaster } = await import(
      '../../src/services/worker/events/SessionEventBroadcaster.js'
    );

    const mockBroadcaster = createMockBroadcaster();
    const mockWorkerService = createMockWorkerService();

    const broadcaster = new SessionEventBroadcaster(
      mockBroadcaster as any,
      mockWorkerService as any
    );

    broadcaster.broadcastSessionStarted(42, 'my-cool-project');

    // Should have broadcast exactly one session_started event + one processing_status update
    // (broadcastProcessingStatus is called but doesn't go through SSEBroadcaster.broadcast)
    const sessionEvents = mockBroadcaster.broadcasts.filter(
      (e: any) => e.type === 'session_started'
    );
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]).toEqual({
      type: 'session_started',
      sessionDbId: 42,
      project: 'my-cool-project',
    });
  });

  it('broadcastSessionCompleted includes project name in SSE payload', async () => {
    const { SessionEventBroadcaster } = await import(
      '../../src/services/worker/events/SessionEventBroadcaster.js'
    );

    const mockBroadcaster = createMockBroadcaster();
    const mockWorkerService = createMockWorkerService();

    const broadcaster = new SessionEventBroadcaster(
      mockBroadcaster as any,
      mockWorkerService as any
    );

    broadcaster.broadcastSessionCompleted(99, 'another-project');

    const completedEvents = mockBroadcaster.broadcasts.filter(
      (e: any) => e.type === 'session_completed'
    );
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({
      type: 'session_completed',
      sessionDbId: 99,
      project: 'another-project',
    });
    // timestamp should also be present
    expect(completedEvents[0].timestamp).toBeNumber();
  });
});
