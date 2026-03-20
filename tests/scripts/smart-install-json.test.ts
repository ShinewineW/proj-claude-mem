import { describe, it, expect } from 'bun:test';
import { execSync } from 'child_process';
import { join } from 'path';

describe('smart-install.js hook contract', () => {
  it('outputs valid JSON as last stdout line', () => {
    const projectRoot = join(__dirname, '../..');
    const scriptPath = join(projectRoot, 'plugin/scripts/smart-install.js');

    const result = execSync(`node ${scriptPath}`, {
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: projectRoot },
      timeout: 30000,
    });

    const lines = result.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const parsed = JSON.parse(lastLine);
    expect(parsed).toHaveProperty('continue', true);
    expect(parsed).toHaveProperty('suppressOutput', true);
  });
});
