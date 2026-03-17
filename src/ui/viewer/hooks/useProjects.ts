import { useState, useEffect, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import type { ProjectInfo, ProjectLatestItem } from '../types';

/**
 * Hook to fetch and periodically refresh the list of enabled projects
 * from the enriched /api/projects endpoint.
 */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchProjects = useCallback(async () => {
    try {
      const response = await fetch(API_ENDPOINTS.PROJECTS);
      const data = await response.json();
      if (data.projectDatabases && Array.isArray(data.projectDatabases)) {
        const parsed: ProjectInfo[] = data.projectDatabases.map((pd: Record<string, unknown>) => {
          let latestItems: ProjectLatestItem[] | undefined;
          if (Array.isArray(pd.latestItems)) {
            latestItems = (pd.latestItems as Record<string, unknown>[]).map(item => ({
              itemType: item.itemType as 'observation' | 'summary' | 'prompt',
              id: item.id as number,
              title: item.title as string | undefined,
              text: item.text as string | undefined,
              type: item.type as string | undefined,
              prompt_text: item.prompt_text as string | undefined,
              created_at_epoch: item.created_at_epoch as number,
            }));
          }
          return {
            project: (pd.project as string) || '',
            dbPath: (pd.dbPath as string) || '',
            projectRoot: (pd.projectRoot as string) || '',
            obsCount: (pd.obsCount as number) || 0,
            sumCount: (pd.sumCount as number) || 0,
            promptCount: (pd.promptCount as number) || 0,
            hasActiveSession: (pd.hasActiveSession as boolean) || false,
            latestItems,
          };
        });
        // Filter out global-DB legacy entries (no projectRoot = no per-project DB)
        setProjects(parsed.filter(p => p.projectRoot !== ''));
      }
    } catch (error) {
      console.error('[useProjects] Failed to fetch projects:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();

    const interval = setInterval(fetchProjects, 60_000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  return { projects, isLoading };
}
