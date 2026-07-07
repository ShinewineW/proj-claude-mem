import { describe, it, expect } from 'bun:test';

// Static source-level regression guard for upstream #2371.
// Verifies chroma-mcp is pinned and onnxruntime/protobuf overrides are injected
// into the uvx spawn args (both persistent and remote modes). No subprocess spawn.
const src = await Bun.file(
  new URL('../../../src/services/sync/ChromaMcpManager.ts', import.meta.url).pathname
).text();

describe('ChromaMcpManager onnx/protobuf pin (#2371)', () => {
  it('declares CHROMA_MCP_PINNED_VERSION = 0.2.6', () => {
    expect(src).toContain("const CHROMA_MCP_PINNED_VERSION = '0.2.6'");
  });

  it('declares onnxruntime and protobuf dep overrides', () => {
    expect(src).toContain("'onnxruntime>=1.20'");
    expect(src).toContain("'protobuf<7'");
  });

  it('pins httpx[socks] so model download works behind a SOCKS proxy', () => {
    // Regression: without socksio in the ephemeral uvx env, chromadb's model
    // download throws "Using SOCKS proxy, but the 'socksio' package is not
    // installed" under ALL_PROXY=socks5://... and the vector store stays empty.
    expect(src).toContain("'httpx[socks]'");
  });

  it('references the pinned version via chroma-mcp==${CHROMA_MCP_PINNED_VERSION}', () => {
    expect(src).toContain('`chroma-mcp==${CHROMA_MCP_PINNED_VERSION}`');
  });

  it('injects dep override flags into both arg builders', () => {
    // depOverrideFlags spread must appear in both the remote and persistent arg arrays
    const occurrences = src.split('...depOverrideFlags').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('does NOT add a Windows quoteForCmdExe helper (POSIX-only port)', () => {
    // POSIX-only port: this invariant is only meaningful on non-Windows runners.
    // On a Windows CI, a quoteForCmdExe helper could legitimately exist, so skip
    // the assertion there rather than report a false POSIX-only breach.
    if (process.platform === 'win32') return;
    expect(src).not.toContain('quoteForCmdExe');
  });
});
