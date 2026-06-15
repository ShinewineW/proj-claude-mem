import { test, expect } from 'bun:test';
import { bypassBadgeView } from '../../src/ui/viewer/components/bypassBadgeView.js';

test('claude fallback when no endpoint/model', () => {
  expect(bypassBadgeView({ state: null, endpoint: null, model: null })).toEqual(
    expect.objectContaining({ label: 'main (claude)', tone: 'disabled' }),
  );
});

test('active host·model label', () => {
  const v = bypassBadgeView({ state: 'ACTIVE', endpoint: 'api.deepseek.com', model: 'deepseek-v4-flash' });
  expect(v.label).toBe('api.deepseek.com · deepseek-v4-flash');
  expect(v.tone).toBe('active');
});

test('tripped tone + failure reason in title', () => {
  const v = bypassBadgeView({ state: 'TRIPPED', endpoint: 'api.deepseek.com', model: 'm', consecutiveFailures: 3, lastFailureReason: 'HTTP 401' });
  expect(v.tone).toBe('tripped');
  expect(v.title).toContain('HTTP 401');
});
