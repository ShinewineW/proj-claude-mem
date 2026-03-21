/**
 * Build-time guard: ensures frontend DEFAULT_SETTINGS stays aligned
 * with backend SettingsDefaultsManager defaults.
 *
 * Catches two types of drift:
 * 1. Value mismatch — same key, different default value
 * 2. Phantom key — frontend key with no backend counterpart
 *
 * Run: bun run scripts/verify-settings-alignment.ts
 * Integrated into: "build" script (blocks build on failure)
 */

import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';
import { DEFAULT_SETTINGS } from '../src/ui/viewer/constants/settings';

const backendDefaults = SettingsDefaultsManager.getAllDefaults();
const frontendKeys = Object.keys(DEFAULT_SETTINGS) as Array<keyof typeof DEFAULT_SETTINGS>;

const mismatches: Array<{ key: string; backend: string; frontend: string }> = [];
const phantomKeys: string[] = [];

for (const key of frontendKeys) {
  if (!(key in backendDefaults)) {
    phantomKeys.push(key);
    continue;
  }
  const backendValue = (backendDefaults as Record<string, string>)[key];
  const frontendValue = DEFAULT_SETTINGS[key];
  if (backendValue !== frontendValue) {
    mismatches.push({ key, backend: backendValue, frontend: frontendValue });
  }
}

if (phantomKeys.length > 0 || mismatches.length > 0) {
  console.error('\n[SETTINGS ALIGNMENT] Frontend/backend default mismatch detected!\n');

  if (phantomKeys.length > 0) {
    console.error('Phantom keys (frontend only, no backend counterpart):');
    for (const key of phantomKeys) {
      console.error(`  - ${key}`);
    }
    console.error('');
  }

  if (mismatches.length > 0) {
    console.error('Value mismatches:');
    console.error('  Key                                    | Backend              | Frontend');
    console.error('  ' + '-'.repeat(85));
    for (const { key, backend, frontend } of mismatches) {
      console.error(`  ${key.padEnd(40)} | ${backend.padEnd(20)} | ${frontend}`);
    }
    console.error('');
  }

  console.error('Fix: update src/ui/viewer/constants/settings.ts to match src/shared/SettingsDefaultsManager.ts\n');
  process.exit(1);
} else {
  console.log(`[SETTINGS ALIGNMENT] OK — ${frontendKeys.length} frontend keys verified against backend defaults`);
}
