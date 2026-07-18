import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

const DEFAULTS = readFileSync("src/shared/SettingsDefaultsManager.ts", "utf-8");

describe("CLAUDE_MEM_OBSERVER_RESUME defaults + UI isolation", () => {
  test("default is \"false\" (new decoupled mode)", () => {
    expect(DEFAULTS).toContain('CLAUDE_MEM_OBSERVER_RESUME: "false"');
  });

  test("flag has no UI exposure: absent from viewer settings constants", () => {
    // Deliberately NOT wired into the viewer (b741d043 wired the OTHER bypass
    // keys; this master switch stays a hand-edit-only escape hatch).
    const constants = readFileSync("src/ui/viewer/constants/settings.ts", "utf-8");
    expect(constants).not.toContain("CLAUDE_MEM_OBSERVER_RESUME");
  });

  test("flag is NOT in the POST /api/settings persistence whitelist", () => {
    // NOTE (评审 R1-2): GET /api/settings returns the FULL merged defaults via
    // SettingsDefaultsManager.loadFromFile(), so the key IS read-visible there —
    // that indirect, read-only exposure is accepted. What this test locks down
    // is the write path: the key must never enter the POST settingKeys whitelist
    // (SettingsRoutes.ts hardcodes that list, so a plain string assertion works).
    const routes = readFileSync(
      "src/services/worker/http/routes/SettingsRoutes.ts",
      "utf-8",
    );
    expect(routes).not.toContain("CLAUDE_MEM_OBSERVER_RESUME");
  });
});
