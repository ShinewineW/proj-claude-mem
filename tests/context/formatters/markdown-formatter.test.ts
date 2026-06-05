import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the ModeManager before importing the formatter
mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [
          { id: 'decision', emoji: 'D' },
          { id: 'bugfix', emoji: 'B' },
          { id: 'discovery', emoji: 'I' },
        ],
        observation_concepts: [],
      }),
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = {
          decision: 'D',
          bugfix: 'B',
          discovery: 'I',
        };
        return icons[type] || '?';
      },
      getWorkEmoji: () => 'W',
    }),
  },
}));

import {
  renderMarkdownHeader,
  renderMarkdownLegend,
  renderMarkdownColumnKey,
  renderMarkdownContextIndex,
  renderMarkdownContextEconomics,
  renderMarkdownDayHeader,
  renderMarkdownFileHeader,
  renderMarkdownTableRow,
  renderMarkdownFullObservation,
  renderMarkdownSummaryItem,
  renderMarkdownSummaryField,
  renderMarkdownPreviouslySection,
  renderMarkdownFooter,
  renderMarkdownEmptyState,
} from '../../../src/services/context/formatters/MarkdownFormatter.js';

import type { Observation, TokenEconomics, ContextConfig, PriorMessages } from '../../../src/services/context/types.js';

// Helper to create a minimal observation
function createTestObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 1,
    memory_session_id: 'session-123',
    type: 'discovery',
    title: 'Test Observation',
    subtitle: null,
    narrative: 'A test narrative',
    facts: '["fact1"]',
    concepts: '["concept1"]',
    files_read: null,
    files_modified: null,
    discovery_tokens: 100,
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    ...overrides,
  };
}

// Helper to create token economics
function createTestEconomics(overrides: Partial<TokenEconomics> = {}): TokenEconomics {
  return {
    totalObservations: 10,
    totalReadTokens: 500,
    totalDiscoveryTokens: 5000,
    savings: 4500,
    savingsPercent: 90,
    ...overrides,
  };
}

// Helper to create context config
function createTestConfig(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return {
    totalObservationCount: 50,
    fullObservationCount: 5,
    sessionCount: 3,
    showReadTokens: true,
    showWorkTokens: true,
    showSavingsAmount: true,
    showSavingsPercent: true,
    observationTypes: new Set(['discovery', 'decision', 'bugfix']),
    observationConcepts: new Set(['concept1', 'concept2']),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: true,
    ...overrides,
  };
}

describe('MarkdownFormatter', () => {
  describe('renderMarkdownHeader', () => {
    it('should produce valid markdown header with project name', () => {
      const result = renderMarkdownHeader('my-project');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/^# \[my-project\] recent context, \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}[ap]m [A-Z]{3,4}$/);
      expect(result[1]).toBe('');
    });

    it('should handle special characters in project name', () => {
      const result = renderMarkdownHeader('project-with-special_chars.v2');

      expect(result[0]).toContain('project-with-special_chars.v2');
    });

    it('should handle empty project name', () => {
      const result = renderMarkdownHeader('');

      expect(result[0]).toMatch(/^# \[\] recent context, \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}[ap]m [A-Z]{3,4}$/);
    });
  });

  describe('renderMarkdownLegend', () => {
    it('should produce compact legend with format + fetch lines', () => {
      const result = renderMarkdownLegend();
      expect(result).toHaveLength(4);
      expect(result[0]).toContain('Legend:');
      expect(result[0]).toContain('🎯session');
      expect(result[1]).toBe('Format: ID TIME TYPE TITLE');
      expect(result[2]).toContain('get_observations');
      expect(result[2]).toContain('mem-search');
      expect(result[3]).toBe('');
    });
  });

  describe('renderMarkdownColumnKey', () => {
    it('returns empty array in compact format', () => {
      expect(renderMarkdownColumnKey()).toEqual([]);
    });
  });

  describe('renderMarkdownContextIndex', () => {
    it('returns empty array in compact format (folded into legend)', () => {
      expect(renderMarkdownContextIndex()).toEqual([]);
    });
  });

  describe('renderMarkdownContextEconomics', () => {
    it('should include observation count and read tokens', () => {
      const economics = createTestEconomics({ totalObservations: 25, totalReadTokens: 1500 });
      const config = createTestConfig();
      const joined = renderMarkdownContextEconomics(economics, config).join('\n');
      expect(joined).toContain('Stats:');
      expect(joined).toContain('25 obs');
      expect(joined).toContain('1,500t read');
    });

    it('should include work tokens', () => {
      const economics = createTestEconomics({ totalDiscoveryTokens: 10000 });
      const config = createTestConfig();
      const joined = renderMarkdownContextEconomics(economics, config).join('\n');
      expect(joined).toContain('10,000t work');
    });

    it('should show saved amount when only showSavingsAmount', () => {
      const economics = createTestEconomics({ savings: 4500, savingsPercent: 90, totalDiscoveryTokens: 5000 });
      const config = createTestConfig({ showSavingsAmount: true, showSavingsPercent: false });
      const joined = renderMarkdownContextEconomics(economics, config).join('\n');
      expect(joined).toContain('4,500t saved');
    });

    it('should show savings percent when showSavingsPercent', () => {
      const economics = createTestEconomics({ savingsPercent: 85, totalDiscoveryTokens: 1000 });
      const config = createTestConfig({ showSavingsAmount: false, showSavingsPercent: true });
      const joined = renderMarkdownContextEconomics(economics, config).join('\n');
      expect(joined).toContain('85% savings');
    });

    it('should not show savings when discovery tokens is 0', () => {
      const economics = createTestEconomics({ totalDiscoveryTokens: 0, savings: 0, savingsPercent: 0 });
      const config = createTestConfig({ showSavingsAmount: true, showSavingsPercent: true });
      const joined = renderMarkdownContextEconomics(economics, config).join('\n');
      expect(joined).not.toContain('saved');
      expect(joined).not.toContain('savings');
    });
  });

  describe('renderMarkdownDayHeader', () => {
    it('should render day as h3 heading without trailing blank', () => {
      const result = renderMarkdownDayHeader('2025-01-01');
      expect(result).toEqual(['### 2025-01-01']);
    });
  });

  describe('renderMarkdownFileHeader', () => {
    it('returns empty array in compact format (no table headers)', () => {
      expect(renderMarkdownFileHeader('src/index.ts')).toEqual([]);
    });
  });

  describe('renderMarkdownTableRow', () => {
    it('should produce a flat line with id time icon title', () => {
      const obs = createTestObservation({ id: 42, title: 'Important Discovery' });
      const config = createTestConfig();
      const result = renderMarkdownTableRow(obs, '10:30 AM', config);
      expect(result).toContain('42');
      expect(result).toContain('Important Discovery');
      expect(result).not.toContain('|');
    });

    it('should compact AM/PM in time', () => {
      const obs = createTestObservation();
      const config = createTestConfig();
      expect(renderMarkdownTableRow(obs, '10:30 AM', config)).toContain('10:30a');
      expect(renderMarkdownTableRow(obs, '2:05 PM', config)).toContain('2:05p');
    });

    it('should use "Untitled" when title is null', () => {
      const obs = createTestObservation({ title: null });
      const config = createTestConfig();
      expect(renderMarkdownTableRow(obs, '10:00 AM', config)).toContain('Untitled');
    });

    it('should use quote mark for repeated (empty) time', () => {
      const obs = createTestObservation();
      const config = createTestConfig();
      expect(renderMarkdownTableRow(obs, '', config)).toContain('"');
    });
  });

  describe('renderMarkdownFullObservation', () => {
    it('should include observation ID and title', () => {
      const obs = createTestObservation({ id: 7, title: 'Full Observation' });
      const config = createTestConfig();
      const joined = renderMarkdownFullObservation(obs, '10:00 AM', 'Detail content', config).join('\n');
      expect(joined).toContain('**7**');
      expect(joined).toContain('**Full Observation**');
    });

    it('should include detail field when provided', () => {
      const obs = createTestObservation();
      const config = createTestConfig();

      const result = renderMarkdownFullObservation(obs, '10:00', 'The detailed narrative here', config);
      const joined = result.join('\n');

      expect(joined).toContain('The detailed narrative here');
    });

    it('should not include detail field when null', () => {
      const obs = createTestObservation();
      const config = createTestConfig();

      const result = renderMarkdownFullObservation(obs, '10:00', null, config);

      // Should not have an extra content block
      expect(result.length).toBeLessThan(5);
    });

    it('should include token info when enabled', () => {
      const obs = createTestObservation({ discovery_tokens: 250 });
      const config = createTestConfig({ showReadTokens: true, showWorkTokens: true });
      const joined = renderMarkdownFullObservation(obs, '10:00 AM', null, config).join('\n');
      expect(joined).toContain('~');
      expect(joined).toContain('t');
    });
  });

  describe('renderMarkdownSummaryItem', () => {
    it('should include session ID with S prefix and compacted time', () => {
      const summary = { id: 5, request: 'Implement feature' };
      const joined = renderMarkdownSummaryItem(summary, '10:00 AM').join('\n');
      expect(joined).toContain('S5');
      expect(joined).toContain('10:00a'); // compactTime applied to summary time too (uniform format)
    });

    it('should include request text', () => {
      const summary = { id: 1, request: 'Build authentication' };

      const result = renderMarkdownSummaryItem(summary, '10:00');
      const joined = result.join('\n');

      expect(joined).toContain('Build authentication');
    });

    it('should use "Session started" when request is null', () => {
      const summary = { id: 1, request: null };

      const result = renderMarkdownSummaryItem(summary, '10:00');
      const joined = result.join('\n');

      expect(joined).toContain('Session started');
    });
  });

  describe('renderMarkdownSummaryField', () => {
    it('should render label and value in bold', () => {
      const result = renderMarkdownSummaryField('Learned', 'How to test');

      expect(result).toHaveLength(2);
      expect(result[0]).toBe('**Learned**: How to test');
      expect(result[1]).toBe('');
    });

    it('should return empty array when value is null', () => {
      const result = renderMarkdownSummaryField('Learned', null);

      expect(result).toHaveLength(0);
    });

    it('should return empty array when value is empty string', () => {
      const result = renderMarkdownSummaryField('Learned', '');

      // Empty string is falsy, so should return empty array
      expect(result).toHaveLength(0);
    });
  });

  describe('renderMarkdownPreviouslySection', () => {
    it('should render section when assistantMessage exists', () => {
      const priorMessages: PriorMessages = {
        userMessage: '',
        assistantMessage: 'I completed the task successfully.',
      };

      const result = renderMarkdownPreviouslySection(priorMessages);
      const joined = result.join('\n');

      expect(joined).toContain('**Previously**');
      expect(joined).toContain('A: I completed the task successfully.');
    });

    it('should return empty when assistantMessage is empty', () => {
      const priorMessages: PriorMessages = {
        userMessage: '',
        assistantMessage: '',
      };

      const result = renderMarkdownPreviouslySection(priorMessages);

      expect(result).toHaveLength(0);
    });

    it('should include separator', () => {
      const priorMessages: PriorMessages = {
        userMessage: '',
        assistantMessage: 'Some message',
      };

      const result = renderMarkdownPreviouslySection(priorMessages);
      const joined = result.join('\n');

      expect(joined).toContain('---');
    });
  });

  describe('renderMarkdownFooter', () => {
    it('should include work token amount', () => {
      const result = renderMarkdownFooter(10000, 500);
      const joined = result.join('\n');

      expect(joined).toContain('10k');
    });

    it('should mention get_observations and mem-search', () => {
      const joined = renderMarkdownFooter(5000, 100).join('\n');
      expect(joined).toContain('get_observations');
      expect(joined).toContain('mem-search');
    });

    it('should round work tokens to nearest thousand', () => {
      const result = renderMarkdownFooter(15500, 100);
      const joined = result.join('\n');

      // 15500 / 1000 = 15.5 -> rounds to 16
      expect(joined).toContain('16k');
    });
  });

  describe('renderMarkdownEmptyState', () => {
    it('should return helpful message with project name', () => {
      const result = renderMarkdownEmptyState('my-project');

      expect(result).toContain('# [my-project] recent context');
      expect(result).toContain('No previous sessions found');
    });

    it('should be valid markdown', () => {
      const result = renderMarkdownEmptyState('test');

      // Should start with h1
      expect(result.startsWith('#')).toBe(true);
    });

    it('should handle empty project name', () => {
      const result = renderMarkdownEmptyState('');

      expect(result).toContain('# [] recent context');
    });
  });
});
