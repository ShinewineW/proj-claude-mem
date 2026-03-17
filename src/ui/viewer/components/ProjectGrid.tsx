import React, { useMemo } from 'react';
import type { ProjectInfo, Observation, Summary, UserPrompt } from '../types';
import { ProjectCard } from './ProjectCard';
import type { LatestItem } from './ProjectCard';
import { SkeletonCard } from './SkeletonCard';

interface ProjectGridProps {
  projects: ProjectInfo[];
  isLoading: boolean;
  sseObservations: Observation[];
  sseSummaries: Summary[];
  ssePrompts: UserPrompt[];
  onProjectClick: (project: ProjectInfo) => void;
}

export function ProjectGrid({
  projects,
  isLoading,
  sseObservations,
  sseSummaries,
  ssePrompts,
  onProjectClick,
}: ProjectGridProps) {
  const projectData = useMemo(() => {
    const result = new Map<string, { latestItems: LatestItem[]; sseExtraCounts: { obs: number; sum: number; ask: number } }>();

    for (const proj of projects) {
      // Start with API latestItems as baseline
      const apiItems: LatestItem[] = (proj.latestItems || []).map(item => ({
        type: item.itemType === 'prompt' ? 'prompt' as const
            : item.itemType === 'summary' ? 'summary' as const
            : 'observation' as const,
        text: item.prompt_text || item.title || item.text || '',
        time: item.created_at_epoch,
      }));

      // Collect SSE items for this project
      const sseItems: LatestItem[] = [];

      for (const obs of sseObservations) {
        if (obs.project === proj.project) {
          sseItems.push({
            type: 'observation',
            text: obs.title || obs.text || '',
            time: obs.created_at_epoch,
          });
        }
      }

      for (const sum of sseSummaries) {
        if (sum.project === proj.project) {
          sseItems.push({
            type: 'summary',
            text: sum.investigated || sum.learned || sum.completed || '',
            time: sum.created_at_epoch,
          });
        }
      }

      for (const prompt of ssePrompts) {
        if (prompt.project === proj.project) {
          sseItems.push({
            type: 'prompt',
            text: prompt.prompt_text,
            time: prompt.created_at_epoch,
          });
        }
      }

      // Merge API + SSE (SSE newer items override)
      const apiMaxEpoch = apiItems.length > 0
        ? Math.max(...apiItems.map(i => i.time))
        : 0;
      const newerSseItems = sseItems.filter(item => item.time > apiMaxEpoch);
      const merged = [...newerSseItems, ...apiItems];
      merged.sort((a, b) => b.time - a.time);

      // Two fixed slots: latest non-ask + latest ask
      const allItems: LatestItem[] = [];
      const latestNonAsk = merged.find(i => i.type !== 'prompt');
      const latestAsk = merged.find(i => i.type === 'prompt');
      if (latestNonAsk) allItems.push(latestNonAsk);
      if (latestAsk) allItems.push(latestAsk);

      // Count SSE events per type for this project
      const sseExtraCounts = {
        obs: sseObservations.filter(o => o.project === proj.project).length,
        sum: sseSummaries.filter(s => s.project === proj.project).length,
        ask: ssePrompts.filter(p => p.project === proj.project).length,
      };

      result.set(proj.project, {
        latestItems: allItems,
        sseExtraCounts,
      });
    }

    return result;
  }, [projects, sseObservations, sseSummaries, ssePrompts]);

  if (isLoading) {
    return (
      <>
        <div className="section-title">Projects</div>
        <div className="project-grid">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </>
    );
  }

  if (projects.length === 0) {
    return (
      <>
        <div className="section-title">Projects</div>
        <div className="project-grid">
          <div style={{
            padding: '40px 20px',
            textAlign: 'center',
            color: 'var(--color-text-muted)',
            fontFamily: 'var(--font-body)',
            fontSize: '14px',
            gridColumn: '1 / -1',
            lineHeight: 1.8,
          }}>
            <div style={{ fontSize: '28px', marginBottom: '8px' }}>No projects enabled</div>
            <div>
              Use <code style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '13px',
                padding: '2px 6px',
                background: 'var(--color-surface)',
                borderRadius: '4px',
                border: '1px solid var(--color-border)',
              }}>/mem-enable</code> in Claude Code to start recording memory for a project.
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="section-title">Projects</div>
      <div className="project-grid">
        {projects.map(proj => {
          const data = projectData.get(proj.project) || { latestItems: [], sseExtraCounts: { obs: 0, sum: 0, ask: 0 } };
          return (
            <ProjectCard
              key={proj.project}
              project={proj}
              latestItems={data.latestItems}
              sseExtraCounts={data.sseExtraCounts}
              onClick={() => onProjectClick(proj)}
            />
          );
        })}
      </div>
    </>
  );
}
