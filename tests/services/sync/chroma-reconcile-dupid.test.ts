import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// Regression for upstream #1566: a duplicate-ID add conflict must be reconciled
// in place via delete+add instead of being dropped until the next backfill.

interface ToolCall { name: string; args: Record<string, unknown>; }
let toolCalls: ToolCall[] = [];
let addAttempts = 0;

const fakeChromaMcp = {
  callTool: async (name: string, args: Record<string, unknown>) => {
    toolCalls.push({ name, args });
    if (name === 'chroma_add_documents') {
      addAttempts += 1;
      // First add fails with a duplicate-ID conflict; the post-delete re-add succeeds.
      if (addAttempts === 1) {
        throw new Error('Error: IDs already exist in collection cm__test');
      }
    }
    return null;
  },
};

mock.module('../../../src/utils/logger.js', () => ({
  logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, failure: () => {} },
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

describe('ChromaSync addDocuments duplicate-ID reconcile (#1566)', () => {
  beforeEach(() => {
    toolCalls = [];
    addAttempts = 0;
    spyOn(ChromaMcpManager, 'getInstance').mockReturnValue(fakeChromaMcp as any);
  });

  afterEach(() => {
    mock.restore();
  });

  it('deletes then re-adds the batch when add fails with "already exist"', async () => {
    const sync = new ChromaSync('test-project');
    // ensureCollectionExists() will call chroma-mcp (chroma_create_collection);
    // the fake returns null for everything except the rigged first add.
    await (sync as any).addDocuments([
      { id: 'obs_1_text', document: 'hello', metadata: { project: 'test-project' } },
    ]);

    const names = toolCalls.map(c => c.name);
    // Expected sequence within the batch: add (fails) -> delete -> add (succeeds).
    expect(names.filter(n => n === 'chroma_delete_documents').length).toBe(1);
    expect(names.filter(n => n === 'chroma_add_documents').length).toBe(2);

    const deleteCall = toolCalls.find(c => c.name === 'chroma_delete_documents');
    expect(deleteCall?.args.ids).toEqual(['obs_1_text']);
  });
});
