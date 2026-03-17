import { useState, useEffect, useCallback, useRef } from 'react';
import type { FeedItem, Observation, Summary, UserPrompt } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { UI } from '../constants/ui';

interface DetailPaginationResult {
  items: FeedItem[];
  loadMore: () => Promise<void>;
  hasMore: boolean;
  isLoading: boolean;
}

interface PageState {
  offset: number;
  hasMore: boolean;
}

/**
 * Fetch a single page from a pagination endpoint.
 *
 * Returns `{ items, hasMore }` matching the server response shape.
 */
async function fetchPage<T>(
  endpoint: string,
  project: string,
  dbPath: string,
  offset: number,
): Promise<{ items: T[]; hasMore: boolean }> {
  const params = new URLSearchParams({
    project,
    dbPath,
    offset: offset.toString(),
    limit: UI.PAGINATION_PAGE_SIZE.toString(),
  });

  const response = await fetch(`${endpoint}?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${endpoint}: ${response.statusText}`);
  }
  return response.json() as Promise<{ items: T[]; hasMore: boolean }>;
}

/**
 * Hook managing paginated data for the detail panel.
 *
 * Fetches observations, summaries, and prompts for a project,
 * merges them chronologically (newest first), and supports
 * infinite-scroll via `loadMore`.
 */
export function useDetailPagination(project: string | null, dbPath: string): DetailPaginationResult {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Track per-type pagination state in refs to avoid stale closures
  const obsPage = useRef<PageState>({ offset: 0, hasMore: true });
  const sumPage = useRef<PageState>({ offset: 0, hasMore: true });
  const promptPage = useRef<PageState>({ offset: 0, hasMore: true });

  // Guard against concurrent fetches
  const isFetching = useRef(false);

  // Track current project to detect resets
  const currentProject = useRef(project);

  const hasMore = obsPage.current.hasMore || sumPage.current.hasMore || promptPage.current.hasMore;

  /**
   * Fetch next page of all three types, merge into existing items.
   */
  const fetchNextPage = useCallback(async (append: boolean) => {
    if (!project) return;
    if (isFetching.current) return;

    isFetching.current = true;
    setIsLoading(true);

    // Fetch all types in parallel, defer offset updates until all succeed
    type PendingResult = { type: 'obs' | 'sum' | 'prompt'; items: FeedItem[]; hasMore: boolean };
    const fetches: Promise<PendingResult>[] = [];

    if (obsPage.current.hasMore) {
      fetches.push(
        fetchPage<Observation>(API_ENDPOINTS.OBSERVATIONS, project, dbPath, obsPage.current.offset)
          .then(result => ({
            type: 'obs' as const,
            items: result.items.map(item => ({ ...item, itemType: 'observation' as const })),
            hasMore: result.hasMore,
          }))
      );
    }

    if (sumPage.current.hasMore) {
      fetches.push(
        fetchPage<Summary>(API_ENDPOINTS.SUMMARIES, project, dbPath, sumPage.current.offset)
          .then(result => ({
            type: 'sum' as const,
            items: result.items.map(item => ({ ...item, itemType: 'summary' as const })),
            hasMore: result.hasMore,
          }))
      );
    }

    if (promptPage.current.hasMore) {
      fetches.push(
        fetchPage<UserPrompt>(API_ENDPOINTS.PROMPTS, project, dbPath, promptPage.current.offset)
          .then(result => ({
            type: 'prompt' as const,
            items: result.items.map(item => ({ ...item, itemType: 'prompt' as const })),
            hasMore: result.hasMore,
          }))
      );
    }

    try {
      const results = await Promise.all(fetches);

      // Only update offsets after all fetches succeed (no partial state corruption)
      for (const r of results) {
        if (r.type === 'obs') { obsPage.current = { offset: obsPage.current.offset + UI.PAGINATION_PAGE_SIZE, hasMore: r.hasMore }; }
        if (r.type === 'sum') { sumPage.current = { offset: sumPage.current.offset + UI.PAGINATION_PAGE_SIZE, hasMore: r.hasMore }; }
        if (r.type === 'prompt') { promptPage.current = { offset: promptPage.current.offset + UI.PAGINATION_PAGE_SIZE, hasMore: r.hasMore }; }
      }

      const newItems = results.flatMap(r => r.items);
      setItems(prev => {
        const combined = append ? [...prev, ...newItems] : newItems;
        return combined.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
      });
    } catch (error) {
      console.error('[useDetailPagination] Fetch failed:', error);
    } finally {
      setIsLoading(false);
      isFetching.current = false;
    }
  }, [project, dbPath]);

  const loadMore = useCallback(async () => {
    await fetchNextPage(true);
  }, [fetchNextPage]);

  // Reset and fetch first page when project changes
  useEffect(() => {
    if (currentProject.current !== project) {
      currentProject.current = project;
    }

    // Reset pagination state
    obsPage.current = { offset: 0, hasMore: true };
    sumPage.current = { offset: 0, hasMore: true };
    promptPage.current = { offset: 0, hasMore: true };
    isFetching.current = false;
    setItems([]);

    if (project) {
      fetchNextPage(false);
    }
  }, [project, dbPath, fetchNextPage]);

  if (!project) {
    return { items: [], loadMore: async () => {}, hasMore: false, isLoading: false };
  }

  return { items, loadMore, hasMore, isLoading };
}
