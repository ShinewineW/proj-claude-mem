export interface Observation {
  id: number;
  memory_session_id: string;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

export interface Summary {
  id: number;
  session_id: string;
  project: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  next_steps?: string;
  files_read?: string;
  files_edited?: string;
  notes?: string;
  prompt_number?: number;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  content_session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

export type FeedItem =
  | (Observation & { itemType: 'observation' })
  | (Summary & { itemType: 'summary' })
  | (UserPrompt & { itemType: 'prompt' });

export interface ProjectLatestItem {
  itemType: 'observation' | 'summary' | 'prompt';
  id: number;
  title?: string;
  text?: string;
  type?: string;
  prompt_text?: string;
  created_at_epoch: number;
}

export interface ProjectInfo {
  project: string;
  dbPath: string;
  projectRoot: string;
  obsCount: number;
  sumCount: number;
  promptCount: number;
  hasActiveSession: boolean;
  latestItems?: ProjectLatestItem[];
}

export interface BypassInfo {
  state: string | null;
  endpoint: string | null;
  model: string | null;
  consecutiveFailures?: number;
  lastFailureReason?: string | null;
}

export interface StreamEvent {
  type: 'initial_load' | 'new_observation' | 'new_summary' | 'new_prompt' | 'processing_status' | 'session_started' | 'session_completed';
  observations?: Observation[];
  summaries?: Summary[];
  prompts?: UserPrompt[];
  projects?: string[];
  observation?: Observation;
  summary?: Summary;
  prompt?: UserPrompt;
  isProcessing?: boolean;
  queueDepth?: number;
  bypass?: BypassInfo;
  sessionDbId?: number;
  project?: string;
}

export interface Settings {
  CLAUDE_MEM_MODEL: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_MEM_WORKER_PORT: string;
  CLAUDE_MEM_WORKER_HOST: string;

  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER?: string;  // 'claude' | 'openai'
  CLAUDE_MEM_OPENAI_API_KEY?: string;
  CLAUDE_MEM_OPENAI_MODEL?: string;
  CLAUDE_MEM_OPENAI_BASE_URL?: string;

  // Token Economics Display
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT?: string;

  // Display Configuration
  CLAUDE_MEM_CONTEXT_FULL_COUNT?: string;
  CLAUDE_MEM_CONTEXT_FULL_FIELD?: string;
  CLAUDE_MEM_CONTEXT_SESSION_COUNT?: string;

  // Feature Toggles
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY?: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE?: string;
}
