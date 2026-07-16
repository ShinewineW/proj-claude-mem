import React, { useState, useCallback, useEffect } from 'react';
import type { Settings } from '../types';
import { TerminalPreview } from './TerminalPreview';
import { BypassTestButton } from './BypassTestButton';
import { useContextPreview } from '../hooks/useContextPreview';
import { DEFAULT_SETTINGS } from '../constants/settings';

interface ContextSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSave: (settings: Settings) => Promise<void>;
}

// Collapsible section component
function CollapsibleSection({
  title,
  description,
  children,
  defaultOpen = true
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`settings-section-collapsible ${isOpen ? 'open' : ''}`}>
      <button
        className="section-header-btn"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="section-header-content">
          <span className="section-title">{title}</span>
          {description && <span className="section-description">{description}</span>}
        </div>
        <svg
          className={`chevron-icon ${isOpen ? 'rotated' : ''}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {isOpen && <div className="section-content">{children}</div>}
    </div>
  );
}

// Form field with optional tooltip
function FormField({
  label,
  tooltip,
  children
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-field">
      <label className="form-field-label">
        {label}
        {tooltip && (
          <span className="tooltip-trigger" title={tooltip}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

// Toggle switch component
function ToggleSwitch({
  id,
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-info">
        <label htmlFor={id} className="toggle-label">{label}</label>
        {description && <span className="toggle-description">{description}</span>}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        className={`toggle-switch ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

export function ContextSettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
}: ContextSettingsModalProps) {
  const [formState, setFormState] = useState<Settings>(settings);

  // Update form state when settings prop changes
  useEffect(() => {
    setFormState(settings);
    lastSavedRef.current = settings;
  }, [settings]);

  // Get context preview based on current form state
  const { preview, isLoading, error, projects, selectedProject, setSelectedProject } = useContextPreview(formState);

  const updateSetting = useCallback((key: keyof Settings, value: string) => {
    const newState = { ...formState, [key]: value };
    setFormState(newState);
  }, [formState]);

  const toggleBoolean = useCallback((key: keyof Settings) => {
    const currentValue = formState[key];
    const newValue = currentValue === 'true' ? 'false' : 'true';
    updateSetting(key, newValue);
  }, [formState, updateSetting]);

  // Handle ESC key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  // Auto-save status
  const [autoSaveStatus, setAutoSaveStatus] = useState<string>('');

  // Track last saved state to prevent save loops
  const lastSavedRef = React.useRef<Settings>(settings);

  // Auto-save on formState change (500ms debounce, loop-safe)
  useEffect(() => {
    if (JSON.stringify(formState) === JSON.stringify(lastSavedRef.current)) {
      return;
    }
    const timeout = setTimeout(() => {
      void onSave(formState)
        .then(() => {
          lastSavedRef.current = formState;
          setAutoSaveStatus('Saved');
          setTimeout(() => setAutoSaveStatus(''), 1500);
        })
        .catch(() => {
          setAutoSaveStatus('Save failed');
        });
    }, 500);
    return () => clearTimeout(timeout);
  }, [formState]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="context-settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>Settings</h2>
          <div className="header-controls">
            <label className="preview-selector">
              Preview for:
              <select
                value={selectedProject || ''}
                onChange={(e) => setSelectedProject(e.target.value)}
              >
                {projects.map(project => (
                  <option key={project} value={project}>{project}</option>
                ))}
              </select>
            </label>
            <button
              onClick={onClose}
              className="modal-close-btn"
              title="Close (Esc)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body - 2 columns */}
        <div className="modal-body">
          {/* Left column - Terminal Preview */}
          <div className="preview-column">
            <div className="preview-content">
              {error ? (
                <div style={{ color: '#ff6b6b' }}>
                  Error loading preview: {error}
                </div>
              ) : (
                <TerminalPreview content={preview} isLoading={isLoading} />
              )}
            </div>
          </div>

          {/* Right column - Settings Panel */}
          <div className="settings-column">
            {/* Section 1: Loading */}
            <CollapsibleSection
              title="Loading"
              description="How many observations to inject"
            >
              <FormField
                label="Observations"
                tooltip="Number of recent observations to include in context (1-200)"
              >
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={formState.CLAUDE_MEM_CONTEXT_OBSERVATIONS ?? DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_OBSERVATIONS}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_OBSERVATIONS', e.target.value)}
                />
              </FormField>
              <FormField
                label="Sessions"
                tooltip="Number of recent sessions to pull observations from (1-50)"
              >
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={formState.CLAUDE_MEM_CONTEXT_SESSION_COUNT ?? DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_SESSION_COUNT}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_SESSION_COUNT', e.target.value)}
                />
              </FormField>
            </CollapsibleSection>

            {/* Section 2: Display */}
            <CollapsibleSection
              title="Display"
              description="What to show in context tables"
            >
              <div className="display-subsection">
                <span className="subsection-label">Full Observations</span>
                <FormField
                  label="Count"
                  tooltip="How many observations show expanded details (0-20)"
                >
                  <input
                    type="number"
                    min="0"
                    max="20"
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_COUNT ?? DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_FULL_COUNT}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_COUNT', e.target.value)}
                  />
                </FormField>
                <FormField
                  label="Field"
                  tooltip="Which field to expand for full observations"
                >
                  <select
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_FIELD ?? DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_FULL_FIELD}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_FIELD', e.target.value)}
                  >
                    <option value="narrative">Narrative</option>
                    <option value="facts">Facts</option>
                  </select>
                </FormField>
              </div>

              <div className="display-subsection">
                <span className="subsection-label">Token Economics</span>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="show-read-tokens"
                    label="Read cost"
                    description="Tokens to read this observation"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-work-tokens"
                    label="Work investment"
                    description="Tokens spent creating this observation"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-savings-amount"
                    label="Savings"
                    description="Total tokens saved by reusing context"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT')}
                  />
                  <ToggleSwitch
                    id="show-savings-percent"
                    label="Savings %"
                    description="Percentage of tokens saved by reusing context"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT')}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Section 4: Advanced */}
            <CollapsibleSection
              title="Advanced"
              description="AI provider and model selection"
              defaultOpen={false}
            >
              <FormField
                label="AI Provider"
                tooltip="Claude (via Agent SDK) or an OpenAI-compatible endpoint (DeepSeek, etc.)"
              >
                <select
                  value={formState.CLAUDE_MEM_PROVIDER ?? DEFAULT_SETTINGS.CLAUDE_MEM_PROVIDER}
                  onChange={(e) => updateSetting('CLAUDE_MEM_PROVIDER', e.target.value)}
                >
                  <option value="claude">Claude (uses your Claude account)</option>
                  <option value="openai">OpenAI-compatible (DeepSeek / self-host / …)</option>
                </select>
              </FormField>

              {formState.CLAUDE_MEM_PROVIDER === 'claude' && (
                <FormField
                  label="Claude Model"
                  tooltip="Claude model used for generating observations"
                >
                  <select
                    value={formState.CLAUDE_MEM_MODEL ?? DEFAULT_SETTINGS.CLAUDE_MEM_MODEL}
                    onChange={(e) => updateSetting('CLAUDE_MEM_MODEL', e.target.value)}
                  >
                    <option value="claude-haiku-4-5-20251001">haiku (fastest)</option>
                    <option value="claude-sonnet-5">sonnet (balanced)</option>
                    <option value="claude-opus-4-5-20250415">opus (highest quality)</option>
                  </select>
                </FormField>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'openai' && (
                <>
                  <FormField label="Base URL" tooltip="OpenAI-compatible endpoint, e.g. https://api.deepseek.com. Required.">
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENAI_BASE_URL ?? ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENAI_BASE_URL', e.target.value)}
                      placeholder="https://api.deepseek.com"
                    />
                  </FormField>
                  <FormField label="API Key" tooltip="Bearer key for the endpoint above (or set OPENAI_API_KEY env var)">
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_OPENAI_API_KEY ?? ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENAI_API_KEY', e.target.value)}
                      placeholder="sk-..."
                    />
                  </FormField>
                  <FormField label="Model" tooltip="Model id, e.g. deepseek-v4-flash. Reasoning models receive thinking:disabled automatically.">
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENAI_MODEL ?? ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENAI_MODEL', e.target.value)}
                      placeholder="deepseek-v4-flash"
                    />
                  </FormField>
                  <BypassTestButton
                    baseUrl={formState.CLAUDE_MEM_OPENAI_BASE_URL ?? ''}
                    apiKey={formState.CLAUDE_MEM_OPENAI_API_KEY ?? ''}
                    model={formState.CLAUDE_MEM_OPENAI_MODEL ?? ''}
                  />
                  <div className="display-subsection">
                    <span className="subsection-label">Bypass Limits</span>
                    <FormField label="Per-session consumers" tooltip="Parallel bypass consumers per session (1-16)">
                      <input
                        type="number"
                        min="1"
                        max="16"
                        value={formState.CLAUDE_MEM_BYPASS_CONCURRENCY ?? DEFAULT_SETTINGS.CLAUDE_MEM_BYPASS_CONCURRENCY}
                        onChange={(e) => updateSetting('CLAUDE_MEM_BYPASS_CONCURRENCY', e.target.value)}
                      />
                    </FormField>
                    <FormField label="Global REST limit" tooltip="Maximum concurrent bypass requests across all sessions (1-64)">
                      <input
                        type="number"
                        min="1"
                        max="64"
                        value={formState.CLAUDE_MEM_BYPASS_MAX_CONSUMERS ?? DEFAULT_SETTINGS.CLAUDE_MEM_BYPASS_MAX_CONSUMERS}
                        onChange={(e) => updateSetting('CLAUDE_MEM_BYPASS_MAX_CONSUMERS', e.target.value)}
                      />
                    </FormField>
                    <FormField label="Failure threshold" tooltip="Consecutive failures before the bypass circuit trips (1-20)">
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={formState.CLAUDE_MEM_BYPASS_MAX_FAILURES ?? DEFAULT_SETTINGS.CLAUDE_MEM_BYPASS_MAX_FAILURES}
                        onChange={(e) => updateSetting('CLAUDE_MEM_BYPASS_MAX_FAILURES', e.target.value)}
                      />
                    </FormField>
                    <FormField label="Retry cooldown (ms)" tooltip="Cooldown for rate-limit and transient failures (1000-86400000 ms)">
                      <input
                        type="number"
                        min="1000"
                        max="86400000"
                        step="1000"
                        value={formState.CLAUDE_MEM_BYPASS_COOLDOWN_MS ?? DEFAULT_SETTINGS.CLAUDE_MEM_BYPASS_COOLDOWN_MS}
                        onChange={(e) => updateSetting('CLAUDE_MEM_BYPASS_COOLDOWN_MS', e.target.value)}
                      />
                    </FormField>
                    <FormField label="Quota cooldown (ms)" tooltip="Cooldown for quota failures (60000-86400000 ms)">
                      <input
                        type="number"
                        min="60000"
                        max="86400000"
                        step="60000"
                        value={formState.CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS ?? DEFAULT_SETTINGS.CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS}
                        onChange={(e) => updateSetting('CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS', e.target.value)}
                      />
                    </FormField>
                    <FormField label="Auth cooldown (ms)" tooltip="Cooldown for authentication failures (60000-86400000 ms)">
                      <input
                        type="number"
                        min="60000"
                        max="86400000"
                        step="60000"
                        value={formState.CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS ?? DEFAULT_SETTINGS.CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS}
                        onChange={(e) => updateSetting('CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS', e.target.value)}
                      />
                    </FormField>
                  </div>
                </>
              )}

              <FormField
                label="Worker Port"
                tooltip="Port for the background worker service"
              >
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={formState.CLAUDE_MEM_WORKER_PORT ?? DEFAULT_SETTINGS.CLAUDE_MEM_WORKER_PORT}
                  onChange={(e) => updateSetting('CLAUDE_MEM_WORKER_PORT', e.target.value)}
                />
              </FormField>

              <div className="toggle-group" style={{ marginTop: '12px' }}>
                <ToggleSwitch
                  id="show-last-summary"
                  label="Include last summary"
                  description="Add previous session's summary to context"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY')}
                />
                <ToggleSwitch
                  id="show-last-message"
                  label="Include last message"
                  description="Add previous session's final message"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE')}
                />
              </div>
            </CollapsibleSection>
          </div>
        </div>

        {/* Footer with auto-save indicator */}
        <div className="modal-footer">
          <span className={`auto-save-status ${autoSaveStatus === 'Saved' ? 'saved' : autoSaveStatus ? 'error' : ''}`}>
            {autoSaveStatus}
          </span>
        </div>
      </div>
    </div>
  );
}
