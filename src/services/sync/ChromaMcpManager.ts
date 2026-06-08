/**
 * ChromaMcpManager - Singleton managing a persistent MCP connection to chroma-mcp via uvx
 *
 * Replaces ChromaServerManager (which spawned `npx chroma run`) with a stdio-based
 * MCP client that communicates with chroma-mcp as a subprocess. The chroma-mcp server
 * handles its own embedding and persistent storage, eliminating the need for a separate
 * HTTP server, chromadb npm package, and ONNX/WASM embedding dependencies.
 *
 * Lifecycle: lazy-connects on first callTool() use, maintains a single persistent
 * connection per worker lifetime, and auto-reconnects if the subprocess dies.
 *
 * Cross-platform: Linux, macOS, Windows
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile, execSync, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

const execFileAsync = promisify(execFile);

const CHROMA_MCP_CLIENT_NAME = 'claude-mem-chroma';
const CHROMA_MCP_CLIENT_VERSION = '1.0.0';
const MCP_CONNECTION_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_MS = 10_000; // Don't retry connections faster than this after failure
const DEFAULT_CHROMA_DATA_DIR = path.join(os.homedir(), '.claude-mem', 'chroma');

const CHROMA_MCP_PINNED_VERSION = '0.2.6';

// Override transitive dep resolutions for chroma-mcp 0.2.6 (issue #2371).
//
// Why onnxruntime>=1.20: the shipped all-MiniLM-L6-v2 model has pytorch-2.0
// IR. Older onnxruntime versions can't parse it and fail every embedding
// add with `[ONNXRuntimeError] : 7 : INVALID_PROTOBUF`. uv may otherwise
// resolve to a too-old onnxruntime on macOS arm64 / Python 3.13 depending
// on cache state, so we force a floor.
//
// Why protobuf<7: protobuf 7.x's stricter generated-file check rejects
// opentelemetry's _pb2 stubs (generated with protoc <3.19), throwing
// `TypeError: Descriptors cannot be created directly` at chromadb import.
// Capping below 7 lands on protobuf 6.x which opentelemetry tolerates.
//
// These pins are runtime-only (uvx --with) so we don't have to fork
// chroma-mcp upstream — they apply only to claude-mem's spawned subprocess.
const CHROMA_MCP_DEP_OVERRIDES: ReadonlyArray<string> = [
  'onnxruntime>=1.20',
  'protobuf<7',
];

export class ChromaMcpManager {
  private static instance: ChromaMcpManager | null = null;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected: boolean = false;
  private lastConnectionFailureTimestamp: number = 0;
  private connecting: Promise<void> | null = null;

  private constructor() {}

  /**
   * Get or create the singleton instance
   */
  static getInstance(): ChromaMcpManager {
    if (!ChromaMcpManager.instance) {
      ChromaMcpManager.instance = new ChromaMcpManager();
    }
    return ChromaMcpManager.instance;
  }

  /**
   * Ensure the MCP client is connected to chroma-mcp.
   * Uses a connection lock to prevent concurrent connection attempts.
   * If the subprocess has died since the last use, reconnects transparently.
   */
  private async ensureConnected(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    // Backoff: don't retry connections too fast after a failure
    const timeSinceLastFailure = Date.now() - this.lastConnectionFailureTimestamp;
    if (this.lastConnectionFailureTimestamp > 0 && timeSinceLastFailure < RECONNECT_BACKOFF_MS) {
      throw new Error(`chroma-mcp connection in backoff (${Math.ceil((RECONNECT_BACKOFF_MS - timeSinceLastFailure) / 1000)}s remaining)`);
    }

    // If another caller is already connecting, wait for that attempt
    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = this.connectInternal();
    try {
      await this.connecting;
    } catch (error) {
      this.lastConnectionFailureTimestamp = Date.now();
      throw error;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Internal connection logic - spawns uvx chroma-mcp and performs MCP handshake.
   * Called behind the connection lock to ensure only one connection attempt at a time.
   */
  private async connectInternal(): Promise<void> {
    // Singleton invariant (#2313): kill any pre-existing chroma-mcp subprocess
    // tree before spawning a new one. The MCP SDK's transport.close() only
    // signals the direct child (uvx); on Linux the grandchildren (uv, python,
    // chroma-mcp) get re-parented to init and survive, accumulating 20+
    // instances per session if reconnects fire repeatedly. Reuse the same
    // tree-kill primitive used by stop() so reconnect can never leave
    // orphans behind. disposeCurrentSubprocess() also resets connected/client/
    // transport, so the prior manual `this.connected = false` is now covered.
    await this.disposeCurrentSubprocess();

    const commandArgs = this.buildCommandArgs();
    const spawnEnvironment = this.getSpawnEnv();

    // On Windows, .cmd files require shell resolution. Since MCP SDK's
    // StdioClientTransport doesn't support `shell: true`, route through
    // cmd.exe which resolves .cmd/.bat extensions and PATH automatically.
    // This also fixes Git Bash compatibility (#1062) since cmd.exe handles
    // Windows-native command resolution regardless of the calling shell.
    const isWindows = process.platform === 'win32';
    let uvxSpawnCommand = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'uvx';
    let uvxSpawnArgs = isWindows ? ['/c', 'uvx', ...commandArgs] : commandArgs;

    // Linux: pin the embedding subprocess to a small CPU set. onnxruntime's
    // intra-op pool ignores thread-limit env vars (non-OpenMP wheel) and
    // oversubscribes on big-host/small-cgroup setups (~150 spinning threads
    // pinning the whole cgroup quota during backfill). CPU affinity is the only
    // OS-enforced cap; taskset exec-replaces itself with uvx so no process
    // layer is added. Gate on taskset presence so hosts without util-linux fall
    // back to the unpinned command. See getChromaCpuLimit().
    if (process.platform === 'linux') {
      const taskset = this.findTaskset();
      if (taskset) {
        const cpuSpec = this.chromaCpuListSpec(this.getChromaCpuLimit());
        uvxSpawnCommand = taskset;
        uvxSpawnArgs = ['-c', cpuSpec, 'uvx', ...commandArgs];
        logger.info('CHROMA_MCP', 'Pinning chroma-mcp to CPU set to bound onnxruntime threads', {
          cpus: cpuSpec
        });
      }
    }

    logger.info('CHROMA_MCP', 'Connecting to chroma-mcp via MCP stdio', {
      command: uvxSpawnCommand,
      args: uvxSpawnArgs.join(' ')
    });

    // Run chroma-mcp from the home directory so that pydantic-settings (used
    // by chroma-mcp internally) does not pick up .env / .env.local files from
    // the project directory. Those files often contain project-specific vars
    // that pydantic rejects with "Extra inputs are not permitted", crashing the
    // subprocess immediately. Fixes #1297.
    this.transport = new StdioClientTransport({
      command: uvxSpawnCommand,
      args: uvxSpawnArgs,
      env: spawnEnvironment,
      cwd: os.homedir(),
      stderr: 'pipe'
    });

    this.client = new Client(
      { name: CHROMA_MCP_CLIENT_NAME, version: CHROMA_MCP_CLIENT_VERSION },
      { capabilities: {} }
    );

    const mcpConnectionPromise = this.client.connect(this.transport);
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`MCP connection to chroma-mcp timed out after ${MCP_CONNECTION_TIMEOUT_MS}ms`)),
        MCP_CONNECTION_TIMEOUT_MS
      );
    });

    try {
      await Promise.race([mcpConnectionPromise, timeoutPromise]);
    } catch (connectionError) {
      // Connection failed or timed out - kill the subprocess tree to prevent zombies
      clearTimeout(timeoutId!);
      logger.warn('CHROMA_MCP', 'Connection failed, killing subprocess tree to prevent zombie', {
        error: connectionError instanceof Error ? connectionError.message : String(connectionError)
      });
      // Tree-kill (not just transport.close) so failed-connect descendants
      // can't survive on Linux (#2313).
      await this.disposeCurrentSubprocess();
      throw connectionError;
    }
    clearTimeout(timeoutId!);

    this.connected = true;

    logger.info('CHROMA_MCP', 'Connected to chroma-mcp successfully');

    // Listen for transport close to mark connection as dead and apply backoff.
    // CRITICAL: Guard with reference check to prevent stale onclose handlers from
    // previous transports overwriting the current connection (race condition).
    const currentTransport = this.transport;
    const currentTrackedPid = (this.transport as unknown as { _process?: ChildProcess })._process?.pid;
    this.transport.onclose = () => {
      if (this.transport !== currentTransport) {
        logger.debug('CHROMA_MCP', 'Ignoring stale onclose from previous transport');
        return;
      }
      logger.warn('CHROMA_MCP', 'chroma-mcp subprocess closed unexpectedly, applying reconnect backoff');
      this.connected = false;
      this.client = null;
      this.transport = null;
      this.lastConnectionFailureTimestamp = Date.now();

      // Direct child (uvx) emitted close, but on Linux the grandchildren
      // (uv/python/chroma-mcp) often outlive their parent because MCP SDK
      // does not use process groups. Sweep the descendant tree using the
      // captured PID — best-effort; pgrep returns nothing if everything
      // already exited (#2313).
      if (currentTrackedPid) {
        ChromaMcpManager.killProcessTree(currentTrackedPid).catch((error) => {
          logger.debug('CHROMA_MCP', 'Background tree-kill after onclose finished (best-effort)', {
            pid: currentTrackedPid,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    };
  }

  /**
   * Build the uvx command arguments based on current settings.
   * In local mode: uses persistent client with local data directory.
   * In remote mode: uses http client with configured host/port/auth.
   */
  private buildCommandArgs(): string[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaMode = settings.CLAUDE_MEM_CHROMA_MODE || 'local';
    const pythonVersion = process.env.CLAUDE_MEM_PYTHON_VERSION || '3.13';

    const depOverrideFlags = CHROMA_MCP_DEP_OVERRIDES.flatMap(spec => ['--with', spec]);

    if (chromaMode === 'remote') {
      const chromaHost = settings.CLAUDE_MEM_CHROMA_HOST || '127.0.0.1';
      const chromaPort = settings.CLAUDE_MEM_CHROMA_PORT || '8000';
      const chromaSsl = settings.CLAUDE_MEM_CHROMA_SSL === 'true';
      const chromaTenant = settings.CLAUDE_MEM_CHROMA_TENANT || 'default_tenant';
      const chromaDatabase = settings.CLAUDE_MEM_CHROMA_DATABASE || 'default_database';
      const chromaApiKey = settings.CLAUDE_MEM_CHROMA_API_KEY || '';

      const args = [
        '--python', pythonVersion,
        ...depOverrideFlags,
        `chroma-mcp==${CHROMA_MCP_PINNED_VERSION}`,
        '--client-type', 'http',
        '--host', chromaHost,
        '--port', chromaPort
      ];

      args.push('--ssl', chromaSsl ? 'true' : 'false');

      if (chromaTenant !== 'default_tenant') {
        args.push('--tenant', chromaTenant);
      }

      if (chromaDatabase !== 'default_database') {
        args.push('--database', chromaDatabase);
      }

      if (chromaApiKey) {
        args.push('--api-key', chromaApiKey);
      }

      return args;
    }

    // Local mode: persistent client with data directory
    return [
      '--python', pythonVersion,
      ...depOverrideFlags,
      `chroma-mcp==${CHROMA_MCP_PINNED_VERSION}`,
      '--client-type', 'persistent',
      '--data-dir', DEFAULT_CHROMA_DATA_DIR.replace(/\\/g, '/')
    ];
  }

  /**
   * Call a chroma-mcp tool by name with the given arguments.
   * Lazily connects on first call. Reconnects if the subprocess has died.
   *
   * @param toolName - The chroma-mcp tool name (e.g. 'chroma_query_documents')
   * @param toolArguments - The tool arguments as a plain object
   * @returns The parsed JSON result from the tool's text output
   */
  async callTool(toolName: string, toolArguments: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected();

    logger.debug('CHROMA_MCP', `Calling tool: ${toolName}`, {
      arguments: JSON.stringify(toolArguments).slice(0, 200)
    });

    let result;
    try {
      result = await this.client!.callTool({
        name: toolName,
        arguments: toolArguments
      });
    } catch (transportError) {
      // Transport error: chroma-mcp subprocess likely died (e.g., killed by orphan reaper,
      // HNSW index corruption). Mark connection dead and retry once after reconnect (#1131).
      // Without this retry, callers see a one-shot error even though reconnect would succeed.
      logger.warn('CHROMA_MCP', `Transport error during "${toolName}", reconnecting and retrying once`, {
        error: transportError instanceof Error ? transportError.message : String(transportError)
      });

      // Tree-kill the dying subprocess before reconnect. Previously this path
      // just nulled the handle, which on Linux leaks the uv/python/chroma-mcp
      // descendants every time a transport error happens (#2313).
      await this.disposeCurrentSubprocess();

      try {
        await this.ensureConnected();
        result = await this.client!.callTool({
          name: toolName,
          arguments: toolArguments
        });
      } catch (retryError) {
        this.connected = false;
        throw new Error(`chroma-mcp transport error during "${toolName}" (retry failed): ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      }
    }

    // MCP tools signal errors via isError flag on the CallToolResult
    if (result.isError) {
      const errorText = (result.content as Array<{ type: string; text?: string }>)
        ?.find(item => item.type === 'text')?.text || 'Unknown chroma-mcp error';
      throw new Error(`chroma-mcp tool "${toolName}" returned error: ${errorText}`);
    }

    // Extract text from MCP CallToolResult: { content: Array<{ type, text? }> }
    const contentArray = result.content as Array<{ type: string; text?: string }>;
    if (!contentArray || contentArray.length === 0) {
      return null;
    }

    const firstTextContent = contentArray.find(item => item.type === 'text' && item.text);
    if (!firstTextContent || !firstTextContent.text) {
      return null;
    }

    // chroma-mcp returns JSON for query/get results, but plain text for
    // mutating operations (e.g. "Successfully created collection ...").
    // Try JSON parse first; if it fails, return the raw text for non-error responses.
    try {
      return JSON.parse(firstTextContent.text);
    } catch {
      // Plain text response (e.g. "Successfully created collection cm__foo")
      // Return null for void-like success messages, callers don't need the text
      return null;
    }
  }

  /**
   * Check if the MCP connection is alive by calling chroma_list_collections.
   * Returns true if the connection is healthy, false otherwise.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.callTool('chroma_list_collections', { limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gracefully stop the MCP connection and kill the chroma-mcp subprocess.
   * client.close() sends stdin close -> SIGTERM -> SIGKILL to the subprocess.
   */
  async stop(): Promise<void> {
    if (!this.client && !this.transport) {
      logger.debug('CHROMA_MCP', 'No active MCP connection to stop');
      this.connecting = null;
      return;
    }

    logger.info('CHROMA_MCP', 'Stopping chroma-mcp MCP connection');

    await this.disposeCurrentSubprocess();
    this.connecting = null;

    logger.info('CHROMA_MCP', 'chroma-mcp MCP connection stopped');
  }

  /**
   * Singleton enforcement helper (#2313): tree-kill the currently tracked
   * chroma-mcp subprocess and reset all state so the next spawn starts clean.
   *
   * Every code path that intends to abandon `this.transport` / `this.client`
   * (reconnect, transport error, connect-timeout, onclose, stop()) MUST funnel
   * through here. The MCP SDK's transport.close() only signals the direct child
   * (uvx); on Linux the grandchildren (uv, python, chroma-mcp) re-parent to
   * init and accumulate. Calling killProcessTree() against the captured PID
   * before we drop the reference is the only way to guarantee at most one
   * chroma-mcp subprocess tree exists per worker process.
   *
   * Idempotent and best-effort — safe to call when there is no active
   * subprocess (no-op in that case).
   */
  private async disposeCurrentSubprocess(): Promise<void> {
    const chromaProcess = (this.transport as unknown as { _process?: ChildProcess })?._process;
    const trackedPid = chromaProcess?.pid;

    if (trackedPid) {
      try {
        await ChromaMcpManager.killProcessTree(trackedPid);
      } catch (error) {
        logger.warn('CHROMA_MCP', 'failed to kill prior chroma-mcp tree (best-effort)', {
          pid: trackedPid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (this.transport) {
      try { await this.transport.close(); } catch { /* already dead */ }
    }
    if (this.client) {
      try { await this.client.close(); } catch { /* already dead */ }
    }

    this.client = null;
    this.transport = null;
    this.connected = false;
  }

  /**
   * Kill a process and all its descendants (tree-kill).
   *
   * `private static` by intent — exercised only via the public abandon paths
   * (the singleton test observes it indirectly through `killTreeCalls`); it is
   * NOT part of the public API and must not be called from outside this class.
   *
   * POSIX: collects the full descendant set via `pgrep -P` walks, then sends
   * SIGTERM (leaves first), waits briefly, then SIGKILL stragglers (union of
   * pre-TERM and post-wait descendant sets to catch re-parented children).
   *
   * Windows: `taskkill /T /F /PID` for full subtree teardown.
   *
   * Best-effort — swallows ESRCH (already dead) and logs other errors.
   */
  private static async killProcessTree(pid: number): Promise<void> {
    logger.debug('CHROMA_MCP', `Killing process tree rooted at PID ${pid}`);

    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          timeout: 5_000,
          windowsHide: true
        });
      } catch (error) {
        // taskkill exits non-zero when the process is already dead — that's fine.
        logger.debug('CHROMA_MCP', `taskkill tree-kill finished (may already be dead)`, {
          pid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    // POSIX: walk descendants recursively (bottom-up) and signal each.
    // `pkill -P <pid>` only reaches direct children, so `python` /
    // `chroma-mcp` under `uv` (grandchildren) get re-parented to init and
    // survive. We collect the full descendant set via `pgrep -P` walks before
    // signaling, so the SIGTERM phase reaches every layer.
    try {
      const descendantsBeforeTerm = await ChromaMcpManager.collectDescendantPids(pid);
      // Signal leaves first, then the root.
      for (const child of descendantsBeforeTerm) {
        try {
          process.kill(child, 'SIGTERM');
        } catch {
          // Already gone — fine.
        }
      }
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          logger.debug('CHROMA_MCP', `Failed to SIGTERM PID ${pid}`, { code });
        }
      }

      // Brief wait for SIGTERM to propagate, then SIGKILL stragglers.
      await new Promise(resolve => setTimeout(resolve, 500));

      // SIGKILL targets the UNION of pre-TERM and post-wait descendant sets:
      // when the root exits between snapshots, children get re-parented to
      // init and drop out of `pgrep -P <root>`. Without the union, those
      // re-parented descendants would never receive SIGKILL even though they
      // were definitely children before SIGTERM. Dedupe via Set.
      const descendantsBeforeKill = await ChromaMcpManager.collectDescendantPids(pid);
      const killTargets = Array.from(new Set([...descendantsBeforeTerm, ...descendantsBeforeKill]));
      for (const child of killTargets) {
        try {
          process.kill(child, 'SIGKILL');
        } catch {
          // Already dead — fine.
        }
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead — fine.
      }
    } catch (error) {
      logger.debug('CHROMA_MCP', `Process tree kill completed (best-effort)`, {
        pid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Recursively collect all descendant PIDs of `rootPid` using `pgrep -P`.
   * Returned bottom-up (leaves first) so callers can signal leaves before
   * their ancestors. Best-effort: missing pgrep / non-zero exits return [].
   *
   * `private static` by intent — internal helper for killProcessTree only.
   */
  private static async collectDescendantPids(rootPid: number): Promise<number[]> {
    const seen = new Set<number>();
    const collected: number[] = [];

    async function walk(pid: number): Promise<void> {
      let stdout = '';
      try {
        const result = await execFileAsync('pgrep', ['-P', String(pid)], { timeout: 2_000 });
        stdout = result.stdout;
      } catch {
        // pgrep exits 1 when no children match — that's fine, just return.
        return;
      }
      const children = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => Number.parseInt(line, 10))
        .filter(n => Number.isFinite(n) && n > 0 && !seen.has(n));

      for (const child of children) {
        seen.add(child);
        await walk(child);
        // Bottom-up: push after recursion so leaves come first.
        collected.push(child);
      }
    }

    await walk(rootPid);
    return collected;
  }

  /**
   * Reset the singleton instance (for testing).
   * Awaits stop() to prevent dual subprocesses.
   */
  static async reset(): Promise<void> {
    if (ChromaMcpManager.instance) {
      await ChromaMcpManager.instance.stop();
    }
    ChromaMcpManager.instance = null;
  }

  /**
   * Get or create a combined SSL certificate bundle for Zscaler/corporate proxy environments.
   * On macOS, combines the Python certifi CA bundle with any Zscaler certificates from
   * the system keychain. Caches the result for 24 hours at ~/.claude-mem/combined_certs.pem.
   *
   * Returns the path to the combined cert file, or undefined if not needed/available.
   */
  private getCombinedCertPath(): string | undefined {
    const combinedCertPath = path.join(os.homedir(), '.claude-mem', 'combined_certs.pem');

    if (fs.existsSync(combinedCertPath)) {
      const stats = fs.statSync(combinedCertPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < 24 * 60 * 60 * 1000) {
        return combinedCertPath;
      }
    }

    if (process.platform !== 'darwin') {
      return undefined;
    }

    try {
      let certifiPath: string | undefined;
      try {
        certifiPath = execSync(
          'uvx --with certifi python -c "import certifi; print(certifi.where())"',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
        ).trim();
      } catch {
        return undefined;
      }

      if (!certifiPath || !fs.existsSync(certifiPath)) {
        return undefined;
      }

      let zscalerCert = '';
      try {
        zscalerCert = execSync(
          'security find-certificate -a -c "Zscaler" -p /Library/Keychains/System.keychain',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
        );
      } catch {
        return undefined;
      }

      if (!zscalerCert ||
          !zscalerCert.includes('-----BEGIN CERTIFICATE-----') ||
          !zscalerCert.includes('-----END CERTIFICATE-----')) {
        return undefined;
      }

      const certifiContent = fs.readFileSync(certifiPath, 'utf8');
      const tempPath = combinedCertPath + '.tmp';
      fs.writeFileSync(tempPath, certifiContent + '\n' + zscalerCert);
      fs.renameSync(tempPath, combinedCertPath);

      logger.info('CHROMA_MCP', 'Created combined SSL certificate bundle for Zscaler', {
        path: combinedCertPath
      });

      return combinedCertPath;
    } catch (error) {
      logger.debug('CHROMA_MCP', 'Could not create combined cert bundle', {}, error as Error);
      return undefined;
    }
  }

  /**
   * Build subprocess environment with SSL certificate overrides for enterprise proxy compatibility.
   * If a combined cert bundle exists (Zscaler), injects SSL_CERT_FILE, REQUESTS_CA_BUNDLE, etc.
   * Otherwise returns a plain string-keyed copy of process.env.
   */
  /**
   * Number of CPUs the chroma-mcp subprocess (onnxruntime embedding) may use.
   *
   * The PyPI onnxruntime wheel is built WITHOUT OpenMP, so it sizes its
   * intra-op thread pool to the host physical-core count and ignores
   * OMP_NUM_THREADS. On a large host carved into a small cgroup (e.g. a
   * 180-core node with a 17-core container quota), that pool oversubscribes:
   * ~150 threads busy-wait at the pool barrier, the cgroup gets CPU-throttled,
   * and a one-time embedding backfill can pin the whole quota for hours.
   * chromadb's embedding function never sets intra_op_num_threads and exposes
   * no env knob, so the only reliable cap is OS-level CPU affinity on the
   * spawned process (see connectInternal); this value sizes that pin.
   *
   * Defaults to a quarter of the detected cgroup CPU quota (clamped to 1..8)
   * so background indexing never starves the rest of the container. Override
   * with CLAUDE_MEM_CHROMA_CPU_LIMIT.
   */
  private getChromaCpuLimit(): number {
    const override = Number.parseInt(process.env.CLAUDE_MEM_CHROMA_CPU_LIMIT ?? '', 10);
    if (Number.isInteger(override) && override > 0) return override;
    const quota = this.readCgroupCpuQuota();
    const base = quota ? Math.floor(quota / 4) : 4;
    return Math.max(1, Math.min(8, base));
  }

  /**
   * Detect this process's CPU quota in whole cores from the cgroup, or null
   * when unconstrained / not on cgroups (macOS, Windows, bare metal).
   */
  private readCgroupCpuQuota(): number | null {
    try {
      // cgroup v2: "<quota> <period>" in µs, or "max" when unconstrained.
      const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
      if (quota && quota !== 'max') {
        const cores = Number(quota) / Number(period || '100000');
        if (cores > 0) return cores;
      }
    } catch { /* not cgroup v2 */ }
    try {
      // cgroup v1: separate quota/period files; quota = -1 when unconstrained.
      const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim());
      const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim());
      if (quota > 0 && period > 0) return quota / period;
    } catch { /* not cgroup v1 */ }
    return null;
  }

  /**
   * Resolve `taskset` on PATH (Linux util-linux), or null when unavailable.
   */
  private findTaskset(): string | null {
    try {
      return execSync('command -v taskset', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Build the `taskset -c` CPU list pinning chroma-mcp to `n` CPUs. Picks the
   * first `n` CPUs from this container's effective cpuset so taskset can't fail
   * with EINVAL on cpuset-restricted pods; falls back to the low `0..n-1` range.
   */
  private chromaCpuListSpec(n: number): string {
    const readSet = (p: string): number[] | null => {
      try {
        const raw = fs.readFileSync(p, 'utf8').trim();
        if (!raw) return null;
        const cpus: number[] = [];
        for (const part of raw.split(',')) {
          const [a, b] = part.split('-').map(Number);
          for (let c = a; c <= (Number.isInteger(b) ? b : a); c++) cpus.push(c);
        }
        return cpus.length ? cpus : null;
      } catch {
        return null;
      }
    };
    const allowed = readSet('/sys/fs/cgroup/cpuset.cpus.effective')
      ?? readSet('/sys/fs/cgroup/cpuset/cpuset.cpus');
    const pick = allowed ? allowed.slice(0, n) : Array.from({ length: n }, (_, i) => i);
    return pick.join(',');
  }

  private getSpawnEnv(): Record<string, string> {
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        baseEnv[key] = value;
      }
    }

    // Disable Chroma's anonymous telemetry — it issues background HTTP from
    // the embedding subprocess on every collection touch. Only set if the
    // user hasn't pinned it explicitly. Must be set BEFORE the combinedCertPath
    // early-return below so it applies to both the cert and no-cert paths.
    if (!baseEnv.ANONYMIZED_TELEMETRY) baseEnv.ANONYMIZED_TELEMETRY = 'false';

    // Cap the auxiliary native thread pools (OpenBLAS/numpy/tokenizers) the
    // embedding subprocess spins up so each doesn't fan out to host-core count.
    // onnxruntime's own intra-op pool ignores these (non-OpenMP wheel) and is
    // bounded by CPU affinity instead (see connectInternal). Only set when the
    // user hasn't pinned them. Must precede the combinedCertPath early-return.
    const chromaThreads = String(this.getChromaCpuLimit());
    for (const key of ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS']) {
      if (!baseEnv[key]) baseEnv[key] = chromaThreads;
    }
    if (!baseEnv.TOKENIZERS_PARALLELISM) baseEnv.TOKENIZERS_PARALLELISM = 'false';

    const combinedCertPath = this.getCombinedCertPath();
    if (!combinedCertPath) {
      return baseEnv;
    }

    logger.info('CHROMA_MCP', 'Using combined SSL certificates for enterprise compatibility', {
      certPath: combinedCertPath
    });

    return {
      ...baseEnv,
      SSL_CERT_FILE: combinedCertPath,
      REQUESTS_CA_BUNDLE: combinedCertPath,
      CURL_CA_BUNDLE: combinedCertPath,
      NODE_EXTRA_CA_CERTS: combinedCertPath
    };
  }
}
