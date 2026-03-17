import React from 'react';
import type { ProjectInfo } from '../types';
import { Badge } from './Badge';

export interface LatestItem {
  type: 'observation' | 'summary' | 'prompt';
  text: string;
  time: number;
}

interface ProjectCardProps {
  project: ProjectInfo;
  latestItems: LatestItem[];
  sseExtraCounts?: { obs: number; sum: number; ask: number };
  onClick: () => void;
}

export function ProjectCard({ project, latestItems, sseExtraCounts, onClick }: ProjectCardProps) {
  const extra = sseExtraCounts || { obs: 0, sum: 0, ask: 0 };
  const displayPath = project.projectRoot.replace(/^\/Users\/[^/]+/, '~');

  // Slot 1: latest non-ask item (observation or summary)
  const latestNonAsk = latestItems.find(i => i.type !== 'prompt');
  // Slot 2: latest ask (prompt)
  const latestAsk = latestItems.find(i => i.type === 'prompt');

  return (
    <div className="project-card" onClick={onClick}>
      <div className="card-top">
        <div>
          <div className="project-name">{project.project}</div>
          <div className="project-path">{displayPath}</div>
        </div>
        {project.hasActiveSession ? (
          <div className="card-status active-session">
            <span className="pulse" />
            active
          </div>
        ) : (
          <div className="card-status idle">idle</div>
        )}
      </div>

      {(latestNonAsk || latestAsk) && (
        <div className="card-latest">
          {latestNonAsk && (
            <div className="latest-item">
              <Badge type={latestNonAsk.type} />
              <span className="latest-text">{latestNonAsk.text}</span>
            </div>
          )}
          {latestAsk && (
            <div className="latest-item">
              <Badge type="prompt" />
              <span className="latest-text">{latestAsk.text}</span>
            </div>
          )}
        </div>
      )}

      <div className="card-footer">
        <div className="card-stat">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span className="card-stat-val">{project.obsCount + extra.obs}</span> obs
        </div>
        <div className="card-stat">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          </svg>
          <span className="card-stat-val">{project.sumCount + extra.sum}</span> sum
        </div>
        <div className="card-stat">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span className="card-stat-val">{project.promptCount + extra.ask}</span> asks
        </div>
      </div>
    </div>
  );
}
