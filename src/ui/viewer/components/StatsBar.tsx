import React, { useMemo, useState, useEffect, useRef } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import type { ProjectInfo } from '../types';

interface TrendPoint {
  day: string;
  count: number;
}

interface TrendData {
  observations: TrendPoint[];
  summaries: TrendPoint[];
}

/** Convert an array of daily counts into an SVG path string within the 80x20 viewBox. */
function countsToSparkPath(counts: number[]): string {
  if (counts.length === 0) return 'M0,18 L80,18';

  const max = Math.max(...counts, 1); // avoid division by zero
  const points = counts.map((c, i) => {
    const x = counts.length === 1 ? 40 : (i / (counts.length - 1)) * 80;
    // y: 2 (top) to 18 (bottom), inverted so higher count = higher line
    const y = 18 - (c / max) * 16;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return `M${points.join(' L')}`;
}

interface StatsBarProps {
  projects: ProjectInfo[];
  queueDepth: number;
  sseObsCount?: number;
  sseSumCount?: number;
}

export function StatsBar({ projects, queueDepth, sseObsCount = 0, sseSumCount = 0 }: StatsBarProps) {
  const [trend, setTrend] = useState<TrendData | null>(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    (async () => {
      try {
        const response = await fetch(`${API_ENDPOINTS.STATS_TREND}?days=7`);
        const data = await response.json();
        if (data.observations && data.summaries) {
          setTrend({
            observations: data.observations as TrendPoint[],
            summaries: data.summaries as TrendPoint[],
          });
        }
      } catch (error) {
        console.error('[StatsBar] Failed to fetch trend data:', error);
      }
    })();
  }, []);

  const stats = useMemo(() => {
    const totalProjects = projects.length;
    const activeCount = projects.filter(p => p.hasActiveSession).length;
    const totalObs = projects.reduce((sum, p) => sum + p.obsCount, 0) + sseObsCount;
    const totalSum = projects.reduce((sum, p) => sum + p.sumCount, 0) + sseSumCount;
    return { totalProjects, activeCount, totalObs, totalSum };
  }, [projects, sseObsCount, sseSumCount]);

  const obsSparkPath = useMemo(() => {
    if (!trend) return 'M0,18 L20,17 L40,18 L60,19 L80,18';
    return countsToSparkPath(trend.observations.map(p => p.count));
  }, [trend]);

  const sumSparkPath = useMemo(() => {
    if (!trend) return 'M0,18 L20,17 L40,18 L60,19 L80,18';
    return countsToSparkPath(trend.summaries.map(p => p.count));
  }, [trend]);

  const sparkClass = trend ? '' : 'flat';

  return (
    <div className="stats-bar">
      <div className="spark-stat">
        <div className="spark-label">Projects</div>
        <div className="spark-num">{stats.totalProjects}</div>
      </div>
      <div className="spark-stat">
        <div className="spark-label">Active</div>
        <div className="spark-num">{stats.activeCount}</div>
      </div>
      <div className="spark-stat">
        <div className="spark-label">Observations</div>
        <div className="spark-num">{stats.totalObs}</div>
        <div className="spark-line">
          <svg viewBox="0 0 80 20" preserveAspectRatio="none">
            <path d={obsSparkPath} className={sparkClass} />
          </svg>
        </div>
      </div>
      <div className="spark-stat">
        <div className="spark-label">Summaries</div>
        <div className="spark-num">{stats.totalSum}</div>
        <div className="spark-line">
          <svg viewBox="0 0 80 20" preserveAspectRatio="none">
            <path d={sumSparkPath} className={sparkClass} />
          </svg>
        </div>
      </div>
      <div className="spark-stat">
        <div className="spark-label">Queued</div>
        <div className="spark-num">{queueDepth}</div>
        <div className="spark-line">
          <svg viewBox="0 0 80 20" preserveAspectRatio="none">
            <path d="M0,18 L20,17 L40,18 L60,19 L80,18" className="flat" />
          </svg>
        </div>
      </div>
    </div>
  );
}
