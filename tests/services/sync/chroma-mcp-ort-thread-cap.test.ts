import { describe, expect, it } from 'bun:test';

// Source-inspection guard: ChromaMcpManager is mock.module-sensitive in the
// full suite, so pin the spawn-env contract without importing the manager.
const src = await Bun.file(
  new URL('../../../src/services/sync/ChromaMcpManager.ts', import.meta.url).pathname
).text();

describe('ChromaMcpManager onnxruntime thread cap', () => {
  it('documents the sitecustomize cap instead of the rejected taskset strategy', () => {
    expect(src).toContain('getSpawnEnv() injects a Python sitecustomize shim');
    expect(src).not.toContain('only reliable cap is OS-level CPU affinity');
    expect(src).not.toContain('this value sizes that pin');
  });

  it('generates a sitecustomize shim that caps InferenceSession options', () => {
    expect(src).toContain("path.join(os.homedir(), '.claude-mem', 'runtime', 'ort-cap')");
    expect(src).toContain("fs.writeFileSync(path.join(dir, 'sitecustomize.py'), body)");
    expect(src).toContain('import onnxruntime as _ort');
    expect(src).toContain('_orig = _ort.InferenceSession.__init__');
    expect(src).toContain('_ort.InferenceSession.__init__ = _capped');
    expect(src).toContain('so.intra_op_num_threads = _n');
    expect(src).toContain('so.inter_op_num_threads = 1');
  });

  it('injects PYTHONPATH and thread env before spawning chroma-mcp', () => {
    expect(src).toContain('if (!baseEnv.CLAUDE_MEM_ORT_INTRA_OP_THREADS)');
    expect(src).toContain('baseEnv.CLAUDE_MEM_ORT_INTRA_OP_THREADS = chromaThreads');
    expect(src).toContain('const sitecustomizeDir = this.ensureOrtCapSitecustomize()');
    expect(src).toContain('baseEnv.PYTHONPATH = baseEnv.PYTHONPATH');
    expect(src).toContain('TOKENIZERS_PARALLELISM');
    expect(src).toContain('env: spawnEnvironment');
  });
});
