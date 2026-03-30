import { describe, it, expect, mock } from 'bun:test';

// Mock ModeManager before import
mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }],
      }),
      getTypeIcon: (type: string) => ({ discovery: '🔵', bugfix: '🔴', feature: '🟣', change: '✅', refactor: '🔄', decision: '⚖️' }[type] || '📌'),
      loadMode: () => {},
    }),
  },
}));

import { buildSessionHistorySummary } from '../../src/sdk/prompts.js';

describe('buildSessionHistorySummary', () => {
  it('returns empty string for zero observations', () => {
    const result = buildSessionHistorySummary([]);
    expect(result).toBe('');
  });

  it('formats single observation correctly', () => {
    const result = buildSessionHistorySummary([
      { type: 'discovery', title: 'Found memory leak in parser', subtitle: null, prompt_number: 1 },
    ]);
    expect(result).toContain('<session_history_summary>');
    expect(result).toContain('1. [discovery] Found memory leak in parser');
    expect(result).toContain('</session_history_summary>');
  });

  it('formats multiple observations in order', () => {
    const rows = [
      { type: 'discovery', title: 'Database isolation violations', subtitle: null, prompt_number: 1 },
      { type: 'feature', title: 'Database path validation test suite', subtitle: null, prompt_number: 2 },
      { type: 'bugfix', title: 'Fixed stale processing message cleanup', subtitle: null, prompt_number: 3 },
    ];
    const result = buildSessionHistorySummary(rows);
    expect(result).toContain('1. [discovery] Database isolation violations');
    expect(result).toContain('2. [feature] Database path validation test suite');
    expect(result).toContain('3. [bugfix] Fixed stale processing message cleanup');
  });

  it('handles null titles gracefully', () => {
    const result = buildSessionHistorySummary([
      { type: 'bugfix', title: null, subtitle: null, prompt_number: 1 },
    ]);
    expect(result).toContain('1. [bugfix] (untitled)');
  });

  it('handles 30 observations within token budget', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      type: 'discovery',
      title: `Observation number ${i + 1} with a descriptive title`,
      subtitle: null,
      prompt_number: i + 1,
    }));
    const result = buildSessionHistorySummary(rows);
    // ~80 chars per observation × 30 = ~2400 chars ≈ 600 tokens. Well under budget.
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain('30. [discovery]');
  });
});
