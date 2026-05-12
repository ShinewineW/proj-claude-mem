import React, { useState, useCallback, useEffect } from 'react';
import { DashboardHeader } from './components/DashboardHeader';
import { StatsBar } from './components/StatsBar';
import { ProjectGrid } from './components/ProjectGrid';
import { RecentFeed } from './components/RecentFeed';
import { DetailPanel } from './components/DetailPanel';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useProjects } from './hooks/useProjects';
import { useRecentActivity } from './hooks/useRecentActivity';
import type { ProjectInfo } from './types';

export function App() {
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);

  const { observations, summaries, prompts, isProcessing, queueDepth, bypassInfo, isConnected, sseSessionStatus, clearSseSessionStatus } = useSSE();
  const { settings, saveSettings } = useSettings();
  const { projects, isLoading: isProjectsLoading } = useProjects();
  const { items: recentItems } = useRecentActivity(observations, summaries, prompts);

  // Clear SSE session status overlay when polling delivers fresh project data
  useEffect(() => {
    clearSseSessionStatus();
  }, [projects, clearSseSessionStatus]);

  // Toggle context preview modal
  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  // Toggle logs modal
  const toggleLogsModal = useCallback(() => {
    setLogsModalOpen(prev => !prev);
  }, []);

  return (
    <>
      <DashboardHeader
        isConnected={isConnected}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        bypassInfo={bypassInfo}
        onSettingsClick={toggleContextPreview}
      />

      <StatsBar
        projects={projects}
        queueDepth={queueDepth}
        sseObsCount={observations.length}
        sseSumCount={summaries.length}
        sseSessionStatus={sseSessionStatus}
      />

      <div className="main">
        <ProjectGrid
          projects={projects}
          isLoading={isProjectsLoading}
          sseObservations={observations}
          sseSummaries={summaries}
          ssePrompts={prompts}
          sseSessionStatus={sseSessionStatus}
          onProjectClick={setSelectedProject}
        />

        <RecentFeed items={recentItems} />
      </div>

      <ContextSettingsModal
        isOpen={contextPreviewOpen}
        onClose={toggleContextPreview}
        settings={settings}
        onSave={saveSettings}
      />

      <DetailPanel
        project={selectedProject}
        onClose={() => setSelectedProject(null)}
      />

      <button
        className="console-toggle-btn"
        onClick={toggleLogsModal}
        title="Toggle Console"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
      </button>

      <LogsDrawer
        isOpen={logsModalOpen}
        onClose={toggleLogsModal}
      />
    </>
  );
}
