/**
 * API endpoint paths
 * Centralized to avoid magic strings scattered throughout the codebase
 */
export const API_ENDPOINTS = {
  OBSERVATIONS: '/api/observations',
  SUMMARIES: '/api/summaries',
  PROMPTS: '/api/prompts',
  SETTINGS: '/api/settings',
  STATS: '/api/stats',
  STATS_TREND: '/api/stats/trend',
  PROCESSING_STATUS: '/api/processing-status',
  STREAM: '/stream',
  PROJECTS: '/api/projects',
  RECENT: '/api/recent',
} as const;
