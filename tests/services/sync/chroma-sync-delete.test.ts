import { describe, test, expect, mock, beforeEach } from 'bun:test';

describe('ChromaSync.deleteObservationDocs', () => {
  let chromaSync: any;
  let callToolMock: ReturnType<typeof mock>;

  beforeEach(async () => {
    callToolMock = mock(async () => ({ content: [{ text: '{"success": true}' }] }));

    // Mock ChromaMcpManager before importing ChromaSync
    const chromaMcpModule = await import('../../../src/services/sync/ChromaMcpManager');
    (chromaMcpModule.ChromaMcpManager as any).getInstance = () => ({
      callTool: callToolMock,
    });

    const { ChromaSync } = await import('../../../src/services/sync/ChromaSync');
    chromaSync = new ChromaSync('test_collection');
    // Mark collection as already created to skip ensureCollectionExists MCP call
    (chromaSync as any).collectionCreated = true;
  });

  test('generates correct candidate IDs and calls chroma_delete_documents', async () => {
    await chromaSync.deleteObservationDocs([42]);

    // Should have called chroma_delete_documents
    const deleteCalls = callToolMock.mock.calls.filter(
      (c: any[]) => c[0] === 'chroma_delete_documents'
    );
    expect(deleteCalls.length).toBeGreaterThan(0);

    // Collect all IDs from all delete calls
    const allIds = deleteCalls.flatMap((c: any[]) => c[1].ids);
    expect(allIds).toContain('obs_42_narrative');
    expect(allIds).toContain('obs_42_text');
    expect(allIds).toContain('obs_42_fact_0');
    expect(allIds).toContain('obs_42_fact_19');
  });

  test('handles empty observation list gracefully', async () => {
    await chromaSync.deleteObservationDocs([]);
    expect(callToolMock).not.toHaveBeenCalled();
  });

  test('does not throw on MCP error', async () => {
    callToolMock = mock(async () => { throw new Error('MCP unavailable'); });
    const chromaMcpModule = await import('../../../src/services/sync/ChromaMcpManager');
    (chromaMcpModule.ChromaMcpManager as any).getInstance = () => ({
      callTool: callToolMock,
    });
    // Re-mark collection created
    (chromaSync as any).collectionCreated = true;

    // Should not throw
    await chromaSync.deleteObservationDocs([1, 2, 3]);
  });
});
