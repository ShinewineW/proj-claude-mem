import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Set env var BEFORE importing the module under test
const testDataDir = join(tmpdir(), `test-allowlist-${Date.now()}`);
mkdirSync(testDataDir, { recursive: true });
process.env.CLAUDE_MEM_DATA_DIR = testDataDir;

// Import AFTER setting env var
import {
  isProjectEnabled,
  enableProject,
  disableProject,
  listEnabledProjects,
  ENABLED_PROJECTS_PATH,
} from "../../src/shared/project-allowlist.js";

describe("project-allowlist", () => {
  beforeEach(() => {
    if (existsSync(ENABLED_PROJECTS_PATH)) {
      rmSync(ENABLED_PROJECTS_PATH);
    }
  });

  afterEach(() => {
    if (existsSync(ENABLED_PROJECTS_PATH)) {
      rmSync(ENABLED_PROJECTS_PATH);
    }
  });

  describe("isProjectEnabled", () => {
    it("returns false when allowlist file does not exist", () => {
      expect(isProjectEnabled("/some/project")).toBe(false);
    });

    it("returns false when project not in allowlist", () => {
      enableProject("/other/project");
      expect(isProjectEnabled("/some/project")).toBe(false);
    });

    it("returns true when project is in allowlist", () => {
      enableProject("/some/project");
      expect(isProjectEnabled("/some/project")).toBe(true);
    });

    it("returns false for empty allowlist file", () => {
      writeFileSync(ENABLED_PROJECTS_PATH, "{}");
      expect(isProjectEnabled("/some/project")).toBe(false);
    });

    it("returns false gracefully when allowlist file is corrupt JSON", () => {
      writeFileSync(ENABLED_PROJECTS_PATH, "not-json{{{");
      expect(isProjectEnabled("/some/project")).toBe(false);
    });
  });

  describe("enableProject", () => {
    it("adds project to allowlist with enabledAt timestamp", () => {
      const before = new Date().toISOString();
      enableProject("/my/project");
      const after = new Date().toISOString();

      const projects = listEnabledProjects();
      expect(projects["/my/project"]).toBeDefined();
      expect(projects["/my/project"].enabledAt >= before).toBe(true);
      expect(projects["/my/project"].enabledAt <= after).toBe(true);
    });

    it("is idempotent — enabling twice keeps entry", () => {
      enableProject("/my/project");
      enableProject("/my/project");
      const projects = listEnabledProjects();
      expect(Object.keys(projects)).toHaveLength(1);
    });

    it("creates allowlist file if it does not exist", () => {
      expect(existsSync(ENABLED_PROJECTS_PATH)).toBe(false);
      enableProject("/my/project");
      expect(existsSync(ENABLED_PROJECTS_PATH)).toBe(true);
    });

    it("preserves existing entries when adding new one", () => {
      enableProject("/project-a");
      enableProject("/project-b");
      const projects = listEnabledProjects();
      expect(projects["/project-a"]).toBeDefined();
      expect(projects["/project-b"]).toBeDefined();
    });
  });

  describe("disableProject", () => {
    it("removes project from allowlist", () => {
      enableProject("/my/project");
      disableProject("/my/project");
      expect(isProjectEnabled("/my/project")).toBe(false);
    });

    it("is a no-op when project not in allowlist", () => {
      expect(() => disableProject("/nonexistent/project")).not.toThrow();
    });

    it("is a no-op when allowlist file does not exist", () => {
      expect(() => disableProject("/my/project")).not.toThrow();
    });

    it("preserves other entries when removing one", () => {
      enableProject("/project-a");
      enableProject("/project-b");
      disableProject("/project-a");
      expect(isProjectEnabled("/project-a")).toBe(false);
      expect(isProjectEnabled("/project-b")).toBe(true);
    });
  });
});
