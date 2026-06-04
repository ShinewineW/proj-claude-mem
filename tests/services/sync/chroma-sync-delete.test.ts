import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager';
import { ChromaSync } from '../../../src/services/sync/ChromaSync';

describe('ChromaSync.deleteObservationDocs', () => {
  let chromaSync: any;
  let callToolMock: ReturnType<typeof mock>;

  beforeEach(() => {
    callToolMock = mock(async () => ({ content: [{ text: '{"success": true}' }] }));
    spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({ callTool: callToolMock } as any);

    chromaSync = new ChromaSync('test_collection');
    // Mark collection as already created to skip ensureCollectionExists MCP call
    (chromaSync as any).collectionCreated = true;
  });

  afterEach(() => {
    mock.restore();
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
    const throwingMock = mock(async () => { throw new Error('MCP unavailable'); });
    spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({ callTool: throwingMock } as any);
    // Re-mark collection created
    (chromaSync as any).collectionCreated = true;

    // Should not throw
    await chromaSync.deleteObservationDocs([1, 2, 3]);
  });
});
