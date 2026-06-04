/**
 * Tests for MCP tool inputSchema declarations (upstream #1384 / #1413, fork-adapted).
 *
 * Validates that search and timeline tools declare their parameters explicitly
 * (including from_project) so MCP clients (Claude Code) can expose them to the LLM.
 *
 * Scope: regression guard, not an exhaustive parameter audit. It asserts the
 * upstream-declared params plus from_project are present and that properties: {}
 * is gone — it does not enumerate every arg the handler may destructure.
 */
import { describe, it, expect } from 'bun:test';

const mcpServerPath = new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname;

describe('MCP tool inputSchema declarations', () => {
  it('search tool declares its parameters', async () => {
    const src = await Bun.file(mcpServerPath).text();
    expect(src).toContain("name: 'search'");
    const searchSection = src.slice(src.indexOf("name: 'search'"), src.indexOf("name: 'timeline'"));
    expect(searchSection).toContain("query:");
    expect(searchSection).toContain("limit:");
    expect(searchSection).toContain("project:");
    expect(searchSection).toContain("type:");
    expect(searchSection).toContain("obs_type:");
    expect(searchSection).toContain("dateStart:");
    expect(searchSection).toContain("dateEnd:");
    expect(searchSection).toContain("offset:");
    expect(searchSection).toContain("orderBy:");
    expect(searchSection).toContain("from_project:");
    expect(searchSection).not.toContain("properties: {}");
    expect(searchSection).toContain("additionalProperties: true");
  });

  it('timeline tool declares its parameters', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const timelineSection = src.slice(
      src.indexOf("name: 'timeline'"),
      src.indexOf("name: 'get_observations'")
    );
    expect(timelineSection).toContain("anchor:");
    expect(timelineSection).toContain("query:");
    expect(timelineSection).toContain("depth_before:");
    expect(timelineSection).toContain("depth_after:");
    expect(timelineSection).toContain("project:");
    expect(timelineSection).toContain("from_project:");
    expect(timelineSection).not.toContain("properties: {}");
    expect(timelineSection).toContain("additionalProperties: true");
  });

  it('get_observations still declares ids (regression check)', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const getObsSection = src.slice(src.indexOf("name: 'get_observations'"));
    expect(getObsSection).toContain("ids:");
    expect(getObsSection).toContain("required:");
  });
});
