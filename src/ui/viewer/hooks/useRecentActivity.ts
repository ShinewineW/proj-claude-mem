import { useState, useEffect, useCallback, useRef } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import type { FeedItem, Observation, Summary, UserPrompt } from '../types';

const MAX_FEED_ITEMS = 20;

/**
 * Hook to fetch initial recent activity from API and merge with SSE events.
 * API provides the initial seed; SSE events are prepended and deduped.
 */
export function useRecentActivity(
  sseObservations: Observation[],
  sseSummaries: Summary[],
  ssePrompts: UserPrompt[],
) {
  const [apiItems, setApiItems] = useState<FeedItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const fetchedRef = useRef(false);

  const fetchRecent = useCallback(async () => {
    try {
      const response = await fetch(`${API_ENDPOINTS.RECENT}?limit=${MAX_FEED_ITEMS}`);
      const data = await response.json();
      if (Array.isArray(data.items)) {
        const parsed: FeedItem[] = (data.items as Record<string, unknown>[]).map(item => {
          const itemType = item.itemType as string;
          // The API returns a unified shape; cast based on itemType
          if (itemType === 'observation') {
            return {
              id: item.id as number,
              memory_session_id: (item.memory_session_id as string) || '',
              project: (item.project as string) || '',
              type: (item.type as string) || '',
              title: (item.title as string | null) || null,
              subtitle: (item.subtitle as string | null) || null,
              narrative: (item.narrative as string | null) || null,
              text: (item.text as string | null) || null,
              facts: (item.facts as string | null) || null,
              concepts: (item.concepts as string | null) || null,
              files_read: (item.files_read as string | null) || null,
              files_modified: (item.files_modified as string | null) || null,
              prompt_number: (item.prompt_number as number | null) || null,
              created_at: (item.created_at as string) || '',
              created_at_epoch: item.created_at_epoch as number,
              itemType: 'observation' as const,
            };
          } else if (itemType === 'summary') {
            return {
              id: item.id as number,
              session_id: (item.session_id as string) || (item.memory_session_id as string) || '',
              project: (item.project as string) || '',
              request: item.request as string | undefined,
              investigated: item.investigated as string | undefined,
              learned: item.learned as string | undefined,
              completed: item.completed as string | undefined,
              next_steps: item.next_steps as string | undefined,
              files_read: (item.files_read as string) || undefined,
              files_edited: (item.files_edited as string) || undefined,
              notes: (item.notes as string) || undefined,
              prompt_number: (item.prompt_number as number) || undefined,
              created_at_epoch: item.created_at_epoch as number,
              itemType: 'summary' as const,
            };
          } else {
            return {
              id: item.id as number,
              content_session_id: (item.content_session_id as string) || '',
              project: (item.project as string) || '',
              prompt_number: (item.prompt_number as number) || 0,
              prompt_text: (item.prompt_text as string) || '',
              created_at_epoch: item.created_at_epoch as number,
              itemType: 'prompt' as const,
            };
          }
        });
        setApiItems(parsed);
      }
    } catch (error) {
      console.error('[useRecentActivity] Failed to fetch recent activity:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      fetchRecent();
    }
  }, [fetchRecent]);

  // Merge SSE events with API items, deduplicating by itemType-id key
  const items: FeedItem[] = (() => {
    const sseItems: FeedItem[] = [
      ...sseObservations.map(o => ({ ...o, itemType: 'observation' as const })),
      ...sseSummaries.map(s => ({ ...s, itemType: 'summary' as const })),
      ...ssePrompts.map(p => ({ ...p, itemType: 'prompt' as const })),
    ];

    // Build a set of SSE item keys for fast dedup
    const sseKeys = new Set(sseItems.map(item => `${item.itemType}-${item.id}`));

    // API items that are not duplicated by SSE
    const uniqueApiItems = apiItems.filter(item => !sseKeys.has(`${item.itemType}-${item.id}`));

    // SSE items first (newest), then non-duplicate API items
    const merged = [...sseItems, ...uniqueApiItems];
    merged.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
    return merged.slice(0, MAX_FEED_ITEMS);
  })();

  return { items, isLoading };
}
