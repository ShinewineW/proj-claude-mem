import { describe, it, expect } from 'bun:test';
import { buildFreshSummaryPrompt } from '../../src/sdk/prompts.js';
import { parseSummary } from '../../src/sdk/parser.js';

describe('FALLBACK_SUMMARY_SCHEMA strengthening', () => {
  it('explicitly warns against verbatim user_request echo in the <request> field', () => {
    const prompt = buildFreshSummaryPrompt({
      userPrompt: 'please help me fix the login bug',
      lastAssistantMessage: 'Fixed',
      observations: [],
      mode: undefined,
    });
    expect(prompt).toContain('NOT a verbatim copy of user_request');
  });

  it('provides a concrete short-title example to constrain <request> semantics', () => {
    const prompt = buildFreshSummaryPrompt({
      userPrompt: 'x',
      lastAssistantMessage: 'y',
      observations: [],
      mode: undefined,
    });
    expect(prompt).toMatch(/fix auth token expiry/i);
  });

  it('both mode-present and mode-undefined prompts ask for a title-like request field', () => {
    const withoutMode = buildFreshSummaryPrompt({
      userPrompt: 'x',
      lastAssistantMessage: 'y',
      observations: [],
      mode: undefined,
    });
    expect(withoutMode).toMatch(/3-8 word title/i);
  });
});

describe('parseSummary verbatim-echo structural guard', () => {
  it('rejects verbatim-echo <request> (structural guard)', () => {
    const verbatimResponse = `<summary>
      <request>please help me fix the login bug where tokens expire</request>
      <investigated>...</investigated>
      <learned>...</learned>
      <completed>...</completed>
      <next_steps></next_steps>
      <notes></notes>
    </summary>`;
    expect(() => parseSummary(
      verbatimResponse,
      undefined,
      { userRequest: 'please help me fix the login bug where tokens expire' },
    )).toThrow(/verbatim/i);
  });

  it('accepts a properly-titled <request>', () => {
    const goodResponse = `<summary>
      <request>fix auth token expiry</request>
      <investigated>...</investigated>
      <learned>...</learned>
      <completed>...</completed>
      <next_steps></next_steps>
      <notes></notes>
    </summary>`;
    expect(() => parseSummary(
      goodResponse,
      undefined,
      { userRequest: 'please help me fix the login bug where tokens expire' },
    )).not.toThrow();
  });

  it('skip_summary does not trigger verbatim check', () => {
    const skipResponse = `<skip_summary reason="nothing-to-say" />`;
    expect(() => parseSummary(
      skipResponse,
      undefined,
      { userRequest: 'anything' },
    )).not.toThrow();
  });

  it('missing userRequest option disables the verbatim check (back-compat)', () => {
    const verbatimResponse = `<summary>
      <request>please help me fix the login bug</request>
      <investigated>...</investigated>
      <learned>...</learned>
      <completed>...</completed>
      <next_steps></next_steps>
      <notes></notes>
    </summary>`;
    expect(() => parseSummary(verbatimResponse)).not.toThrow();
  });
});
