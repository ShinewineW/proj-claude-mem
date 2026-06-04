import { describe, it, expect } from 'bun:test';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';

// Minimal SessionSearch stub: FTS5 capability per opts, every search returns [] (valid no-match).
function makeSM(opts: { fts5: boolean }) {
  const emptySearch = {
    isFts5Available: () => opts.fts5,
    searchObservations: () => [],
    searchSessions: () => [],
    searchUserPrompts: () => [],
  } as any;
  const sessionStore = {} as any;       // unused on the zero-result text path
  const chromaSync = null;              // null → with query text, PATH 2 (`else if (this.chromaSync)`) is skipped and the FTS-fallback else-branch runs
  const formatter = {} as any;          // unused: the zero-result branch returns its text inline, not via the formatter
  const timelineService = {} as any;    // unused on this path
  // REAL constructor order (verified SearchManager.ts:31): (sessionSearch, sessionStore, chromaSync, formatter, timelineService)
  return new SearchManager(emptySearch, sessionStore, chromaSync, formatter, timelineService);
}

describe('FTS5 fallback no-match vs no-capability (B2)', () => {
  it('FTS5 available + zero matches → normal "No results found", NOT "Vector search failed"', async () => {
    const sm = makeSM({ fts5: true });
    const res: any = await sm.search({ query: 'definitely-no-such-term', format: 'text' });
    const text = res?.content?.[0]?.text ?? '';
    expect(text).not.toContain('Vector search failed');
    expect(text.toLowerCase()).toContain('no results');
  });

  it('no FTS5 capability + zero matches → "Vector search failed" install guidance', async () => {
    const sm = makeSM({ fts5: false });
    const res: any = await sm.search({ query: 'definitely-no-such-term', format: 'text' });
    const text = res?.content?.[0]?.text ?? '';
    expect(text).toContain('Vector search failed');
  });
});
