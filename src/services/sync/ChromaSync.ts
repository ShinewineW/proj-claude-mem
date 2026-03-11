/**
 * ChromaSync Service
 *
 * Automatically syncs observations and session summaries to ChromaDB via MCP.
 * This service provides real-time semantic search capabilities by maintaining
 * a vector database synchronized with SQLite.
 *
 * Uses ChromaMcpManager to communicate with chroma-mcp over stdio MCP protocol.
 * The chroma-mcp server handles its own embedding and persistent storage,
 * eliminating the need for chromadb npm package and ONNX/WASM dependencies.
 *
 * Design: Fail-fast with no fallbacks - if Chroma is unavailable, syncing fails.
 */

import { ChromaMcpManager } from './ChromaMcpManager.js';
import { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import type { DatabaseManager } from '../worker/DatabaseManager.js';

interface ChromaDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

interface StoredObservation {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null; // JSON
  narrative: string | null;
  concepts: string | null; // JSON
  files_read: string | null; // JSON
  files_modified: string | null; // JSON
  prompt_number: number;
  discovery_tokens: number; // ROI metrics
  created_at: string;
  created_at_epoch: number;
}

interface StoredSummary {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  prompt_number: number;
  discovery_tokens: number; // ROI metrics
  created_at: string;
  created_at_epoch: number;
}

interface StoredUserPrompt {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
  memory_session_id: string;
  project: string;
}

export class ChromaSync {
  private collectionName: string;
  private collectionCreated = false;
  private readonly BATCH_SIZE = 100;
  /** Max fact docs per observation for deletion candidate generation.
   *  Must be >= max facts any observation can have. */
  private static readonly MAX_FACTS_PER_OBS = 20;

  constructor(collectionName: string) {
    this.collectionName = collectionName;
  }

  /**
   * Ensure collection exists in Chroma via MCP.
   * chroma_create_collection is idempotent - safe to call multiple times.
   * Uses collectionCreated flag to avoid redundant calls within a session.
   */
  private async ensureCollectionExists(): Promise<void> {
    if (this.collectionCreated) {
      return;
    }

    const chromaMcp = ChromaMcpManager.getInstance();
    try {
      await chromaMcp.callTool('chroma_create_collection', {
        collection_name: this.collectionName
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already exists')) {
        throw error;
      }
      // Collection already exists - this is the expected path after first creation
    }

    this.collectionCreated = true;

    logger.debug('CHROMA_SYNC', 'Collection ready', {
      collection: this.collectionName
    });
  }

  /**
   * Format observation into Chroma documents (granular approach)
   * Each semantic field becomes a separate vector document
   */
  private formatObservationDocs(obs: StoredObservation): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    // Parse JSON fields
    const facts = obs.facts ? JSON.parse(obs.facts) : [];
    const concepts = obs.concepts ? JSON.parse(obs.concepts) : [];
    const files_read = obs.files_read ? JSON.parse(obs.files_read) : [];
    const files_modified = obs.files_modified ? JSON.parse(obs.files_modified) : [];

    const baseMetadata: Record<string, string | number> = {
      sqlite_id: obs.id,
      doc_type: 'observation',
      memory_session_id: obs.memory_session_id,
      project: obs.project,
      created_at_epoch: obs.created_at_epoch,
      type: obs.type || 'discovery',
      title: obs.title || 'Untitled'
    };

    // Add optional metadata fields
    if (obs.subtitle) {
      baseMetadata.subtitle = obs.subtitle;
    }
    if (concepts.length > 0) {
      baseMetadata.concepts = concepts.join(',');
    }
    if (files_read.length > 0) {
      baseMetadata.files_read = files_read.join(',');
    }
    if (files_modified.length > 0) {
      baseMetadata.files_modified = files_modified.join(',');
    }

    // Narrative as separate document
    if (obs.narrative) {
      documents.push({
        id: `obs_${obs.id}_narrative`,
        document: obs.narrative,
        metadata: { ...baseMetadata, field_type: 'narrative' }
      });
    }

    // Text as separate document (legacy field)
    if (obs.text) {
      documents.push({
        id: `obs_${obs.id}_text`,
        document: obs.text,
        metadata: { ...baseMetadata, field_type: 'text' }
      });
    }

    // Each fact as separate document
    facts.forEach((fact: string, index: number) => {
      documents.push({
        id: `obs_${obs.id}_fact_${index}`,
        document: fact,
        metadata: { ...baseMetadata, field_type: 'fact', fact_index: index }
      });
    });

    return documents;
  }

  /**
   * Format summary into Chroma documents (granular approach)
   * Each summary field becomes a separate vector document
   */
  private formatSummaryDocs(summary: StoredSummary): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    const baseMetadata: Record<string, string | number> = {
      sqlite_id: summary.id,
      doc_type: 'session_summary',
      memory_session_id: summary.memory_session_id,
      project: summary.project,
      created_at_epoch: summary.created_at_epoch,
      prompt_number: summary.prompt_number || 0
    };

    // Each field becomes a separate document
    if (summary.request) {
      documents.push({
        id: `summary_${summary.id}_request`,
        document: summary.request,
        metadata: { ...baseMetadata, field_type: 'request' }
      });
    }

    if (summary.investigated) {
      documents.push({
        id: `summary_${summary.id}_investigated`,
        document: summary.investigated,
        metadata: { ...baseMetadata, field_type: 'investigated' }
      });
    }

    if (summary.learned) {
      documents.push({
        id: `summary_${summary.id}_learned`,
        document: summary.learned,
        metadata: { ...baseMetadata, field_type: 'learned' }
      });
    }

    if (summary.completed) {
      documents.push({
        id: `summary_${summary.id}_completed`,
        document: summary.completed,
        metadata: { ...baseMetadata, field_type: 'completed' }
      });
    }

    if (summary.next_steps) {
      documents.push({
        id: `summary_${summary.id}_next_steps`,
        document: summary.next_steps,
        metadata: { ...baseMetadata, field_type: 'next_steps' }
      });
    }

    if (summary.notes) {
      documents.push({
        id: `summary_${summary.id}_notes`,
        document: summary.notes,
        metadata: { ...baseMetadata, field_type: 'notes' }
      });
    }

    return documents;
  }

  /**
   * Add documents to Chroma in batch via MCP
   * Throws error if batch add fails
   */
  private async addDocuments(documents: ChromaDocument[]): Promise<void> {
    if (documents.length === 0) {
      return;
    }

    await this.ensureCollectionExists();

    const chromaMcp = ChromaMcpManager.getInstance();

    // Add in batches
    for (let i = 0; i < documents.length; i += this.BATCH_SIZE) {
      const batch = documents.slice(i, i + this.BATCH_SIZE);

      // Sanitize metadata: filter out null, undefined, and empty string values
      // that chroma-mcp may reject (e.g., null subtitle from raw SQLite rows)
      const cleanMetadatas = batch.map(d =>
        Object.fromEntries(
          Object.entries(d.metadata).filter(([_, v]) => v !== null && v !== undefined && v !== '')
        )
      );

      try {
        await chromaMcp.callTool('chroma_add_documents', {
          collection_name: this.collectionName,
          ids: batch.map(d => d.id),
          documents: batch.map(d => d.document),
          metadatas: cleanMetadatas
        });
      } catch (error) {
        logger.error('CHROMA_SYNC', 'Batch add failed, continuing with remaining batches', {
          collection: this.collectionName,
          batchStart: i,
          batchSize: batch.length
        }, error as Error);
      }
    }

    logger.debug('CHROMA_SYNC', 'Documents added', {
      collection: this.collectionName,
      count: documents.length
    });
  }

  /**
   * Delete all Chroma documents associated with the given observation IDs.
   * Each observation may have multiple docs (narrative, text, fact_0..N).
   * Since chroma_delete_documents silently ignores non-existent IDs,
   * we generate candidate IDs and delete them all. Fire-and-forget.
   */
  async deleteObservationDocs(observationIds: number[]): Promise<void> {
    if (observationIds.length === 0) return;

    try {
      await this.ensureCollectionExists();
      const chromaMcp = ChromaMcpManager.getInstance();

      // Generate candidate document IDs for each observation
      // Known patterns: obs_{id}_narrative, obs_{id}_text, obs_{id}_fact_{0..19}
      const allIdsToDelete: string[] = [];
      for (const obsId of observationIds) {
        allIdsToDelete.push(`obs_${obsId}_narrative`);
        allIdsToDelete.push(`obs_${obsId}_text`);
        for (let f = 0; f < ChromaSync.MAX_FACTS_PER_OBS; f++) {
          allIdsToDelete.push(`obs_${obsId}_fact_${f}`);
        }
      }

      // Delete in batches (chroma_delete_documents silently ignores non-existent IDs)
      for (let i = 0; i < allIdsToDelete.length; i += this.BATCH_SIZE) {
        const batch = allIdsToDelete.slice(i, i + this.BATCH_SIZE);
        try {
          await chromaMcp.callTool('chroma_delete_documents', {
            collection_name: this.collectionName,
            ids: batch,
          });
        } catch (e) {
          logger.warn('CHROMA_SYNC', 'Batch delete failed, continuing', {
            collection: this.collectionName,
            batchSize: batch.length,
          }, e as Error);
        }
      }

      logger.info('CHROMA_SYNC', `Deleted Chroma docs for ${observationIds.length} observations`, {
        collection: this.collectionName,
        candidateIds: allIdsToDelete.length,
      });
    } catch (error) {
      logger.warn('CHROMA_SYNC', 'Failed to delete observation docs from Chroma', {
        collection: this.collectionName,
        observationCount: observationIds.length,
      }, error as Error);
      // Fire-and-forget: Chroma cleanup is best-effort
    }
  }

  /**
   * Sync a single observation to Chroma
   * Blocks until sync completes, throws on error
   */
  async syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: ParsedObservation,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens: number = 0
  ): Promise<void> {
    // Convert ParsedObservation to StoredObservation format
    const stored: StoredObservation = {
      id: observationId,
      memory_session_id: memorySessionId,
      project: project,
      text: null, // Legacy field, not used
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      facts: JSON.stringify(obs.facts),
      narrative: obs.narrative,
      concepts: JSON.stringify(obs.concepts),
      files_read: JSON.stringify(obs.files_read),
      files_modified: JSON.stringify(obs.files_modified),
      prompt_number: promptNumber,
      discovery_tokens: discoveryTokens,
      created_at: new Date(createdAtEpoch * 1000).toISOString(),
      created_at_epoch: createdAtEpoch
    };

    const documents = this.formatObservationDocs(stored);

    logger.info('CHROMA_SYNC', 'Syncing observation', {
      observationId,
      documentCount: documents.length,
      project
    });

    await this.addDocuments(documents);
  }

  /**
   * Sync a single summary to Chroma
   * Blocks until sync completes, throws on error
   */
  async syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: ParsedSummary,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens: number = 0
  ): Promise<void> {
    // Convert ParsedSummary to StoredSummary format
    const stored: StoredSummary = {
      id: summaryId,
      memory_session_id: memorySessionId,
      project: project,
      request: summary.request,
      investigated: summary.investigated,
      learned: summary.learned,
      completed: summary.completed,
      next_steps: summary.next_steps,
      notes: summary.notes,
      prompt_number: promptNumber,
      discovery_tokens: discoveryTokens,
      created_at: new Date(createdAtEpoch * 1000).toISOString(),
      created_at_epoch: createdAtEpoch
    };

    const documents = this.formatSummaryDocs(stored);

    logger.info('CHROMA_SYNC', 'Syncing summary', {
      summaryId,
      documentCount: documents.length,
      project
    });

    await this.addDocuments(documents);
  }

  /**
   * Format user prompt into Chroma document
   * Each prompt becomes a single document (unlike observations/summaries which split by field)
   */
  private formatUserPromptDoc(prompt: StoredUserPrompt): ChromaDocument {
    return {
      id: `prompt_${prompt.id}`,
      document: prompt.prompt_text,
      metadata: {
        sqlite_id: prompt.id,
        doc_type: 'user_prompt',
        memory_session_id: prompt.memory_session_id,
        project: prompt.project,
        created_at_epoch: prompt.created_at_epoch,
        prompt_number: prompt.prompt_number
      }
    };
  }

  /**
   * Sync a single user prompt to Chroma
   * Blocks until sync completes, throws on error
   */
  async syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number
  ): Promise<void> {
    // Create StoredUserPrompt format
    const stored: StoredUserPrompt = {
      id: promptId,
      content_session_id: '', // Not needed for Chroma sync
      prompt_number: promptNumber,
      prompt_text: promptText,
      created_at: new Date(createdAtEpoch * 1000).toISOString(),
      created_at_epoch: createdAtEpoch,
      memory_session_id: memorySessionId,
      project: project
    };

    const document = this.formatUserPromptDoc(stored);

    logger.info('CHROMA_SYNC', 'Syncing user prompt', {
      promptId,
      project
    });

    await this.addDocuments([document]);
  }

  /**
   * Fetch all existing document IDs from Chroma collection via MCP
   * Returns Sets of SQLite IDs for observations, summaries, and prompts
   */
  private async getExistingChromaIds(): Promise<{
    observations: Set<number>;
    summaries: Set<number>;
    prompts: Set<number>;
  }> {
    await this.ensureCollectionExists();

    const chromaMcp = ChromaMcpManager.getInstance();

    const observationIds = new Set<number>();
    const summaryIds = new Set<number>();
    const promptIds = new Set<number>();

    let offset = 0;
    const limit = 1000; // Large batches, metadata only = fast

    logger.info('CHROMA_SYNC', 'Fetching existing Chroma document IDs...', { collection: this.collectionName });

    while (true) {
      const result = await chromaMcp.callTool('chroma_get_documents', {
        collection_name: this.collectionName,
        limit: limit,
        offset: offset,
        include: ['metadatas']
      }) as any;

      // chroma_get_documents returns flat arrays: { ids, metadatas, documents }
      const metadatas = result?.metadatas || [];

      if (metadatas.length === 0) {
        break; // No more documents
      }

      // Extract SQLite IDs from metadata
      for (const meta of metadatas) {
        if (meta && meta.sqlite_id) {
          const sqliteId = meta.sqlite_id as number;
          if (meta.doc_type === 'observation') {
            observationIds.add(sqliteId);
          } else if (meta.doc_type === 'session_summary') {
            summaryIds.add(sqliteId);
          } else if (meta.doc_type === 'user_prompt') {
            promptIds.add(sqliteId);
          }
        }
      }

      offset += limit;

      logger.debug('CHROMA_SYNC', 'Fetched batch of existing IDs', {
        collection: this.collectionName,
        offset,
        batchSize: metadatas.length
      });
    }

    logger.info('CHROMA_SYNC', 'Existing IDs fetched', {
      collection: this.collectionName,
      observations: observationIds.size,
      summaries: summaryIds.size,
      prompts: promptIds.size
    });

    return { observations: observationIds, summaries: summaryIds, prompts: promptIds };
  }

  /**
   * Backfill: Sync all observations missing from Chroma
   * Reads from the injected SessionStore and syncs in batches.
   * Per-project DB is already scoped, so no project WHERE filter needed.
   *
   * Args:
   *     sessionStore: Caller-owned SessionStore targeting the project DB.
   *
   * Throws error if backfill fails.
   */
  async ensureBackfilled(sessionStore: SessionStore): Promise<void> {
    logger.info('CHROMA_SYNC', 'Starting smart backfill', { collection: this.collectionName });

    await this.ensureCollectionExists();

    // Fetch existing IDs from Chroma (fast, metadata only)
    const existing = await this.getExistingChromaIds();

    const db = sessionStore.db;

    // Build exclusion list for observations.
    // IDs are interpolated into SQL (not parameterized) because SQLite has a
    // variable limit (~999). Filter to validated positive integers to prevent injection.
    const existingObsIds = Array.from(existing.observations).filter(id => Number.isInteger(id) && id > 0);
    const obsExclusionClause = existingObsIds.length > 0
      ? `AND id NOT IN (${existingObsIds.join(',')})`
      : '';

    // Get only observations missing from Chroma
    const observations = db.prepare(`
      SELECT * FROM observations
      WHERE 1=1 ${obsExclusionClause}
      ORDER BY id ASC
    `).all() as StoredObservation[];

    const totalObsCount = db.prepare(`
      SELECT COUNT(*) as count FROM observations WHERE 1=1
    `).get() as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling observations', {
      collection: this.collectionName,
      missing: observations.length,
      existing: existing.observations.size,
      total: totalObsCount.count
    });

    // Format all observation documents
    const allDocs: ChromaDocument[] = [];
    for (const obs of observations) {
      allDocs.push(...this.formatObservationDocs(obs));
    }

    // Sync in batches
    for (let i = 0; i < allDocs.length; i += this.BATCH_SIZE) {
      const batch = allDocs.slice(i, i + this.BATCH_SIZE);
      await this.addDocuments(batch);

      logger.debug('CHROMA_SYNC', 'Backfill progress', {
        collection: this.collectionName,
        progress: `${Math.min(i + this.BATCH_SIZE, allDocs.length)}/${allDocs.length}`
      });
    }

    // Build exclusion list for summaries
    const existingSummaryIds = Array.from(existing.summaries).filter(id => Number.isInteger(id) && id > 0);
    const summaryExclusionClause = existingSummaryIds.length > 0
      ? `AND id NOT IN (${existingSummaryIds.join(',')})`
      : '';

    // Get only summaries missing from Chroma
    const summaries = db.prepare(`
      SELECT * FROM session_summaries
      WHERE 1=1 ${summaryExclusionClause}
      ORDER BY id ASC
    `).all() as StoredSummary[];

    const totalSummaryCount = db.prepare(`
      SELECT COUNT(*) as count FROM session_summaries WHERE 1=1
    `).get() as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling summaries', {
      collection: this.collectionName,
      missing: summaries.length,
      existing: existing.summaries.size,
      total: totalSummaryCount.count
    });

    // Format all summary documents
    const summaryDocs: ChromaDocument[] = [];
    for (const summary of summaries) {
      summaryDocs.push(...this.formatSummaryDocs(summary));
    }

    // Sync in batches
    for (let i = 0; i < summaryDocs.length; i += this.BATCH_SIZE) {
      const batch = summaryDocs.slice(i, i + this.BATCH_SIZE);
      await this.addDocuments(batch);

      logger.debug('CHROMA_SYNC', 'Backfill progress', {
        collection: this.collectionName,
        progress: `${Math.min(i + this.BATCH_SIZE, summaryDocs.length)}/${summaryDocs.length}`
      });
    }

    // Build exclusion list for prompts
    const existingPromptIds = Array.from(existing.prompts).filter(id => Number.isInteger(id) && id > 0);
    const promptExclusionClause = existingPromptIds.length > 0
      ? `AND up.id NOT IN (${existingPromptIds.join(',')})`
      : '';

    // Get only user prompts missing from Chroma
    const prompts = db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE 1=1 ${promptExclusionClause}
      ORDER BY up.id ASC
    `).all() as StoredUserPrompt[];

    const totalPromptCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE 1=1
    `).get() as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling user prompts', {
      collection: this.collectionName,
      missing: prompts.length,
      existing: existing.prompts.size,
      total: totalPromptCount.count
    });

    // Format all prompt documents
    const promptDocs: ChromaDocument[] = [];
    for (const prompt of prompts) {
      promptDocs.push(this.formatUserPromptDoc(prompt));
    }

    // Sync in batches
    for (let i = 0; i < promptDocs.length; i += this.BATCH_SIZE) {
      const batch = promptDocs.slice(i, i + this.BATCH_SIZE);
      await this.addDocuments(batch);

      logger.debug('CHROMA_SYNC', 'Backfill progress', {
        collection: this.collectionName,
        progress: `${Math.min(i + this.BATCH_SIZE, promptDocs.length)}/${promptDocs.length}`
      });
    }

    logger.info('CHROMA_SYNC', 'Smart backfill complete', {
      collection: this.collectionName,
      synced: {
        observationDocs: allDocs.length,
        summaryDocs: summaryDocs.length,
        promptDocs: promptDocs.length
      },
      skipped: {
        observations: existing.observations.size,
        summaries: existing.summaries.size,
        prompts: existing.prompts.size
      }
    });
  }

  /**
   * Query Chroma collection for semantic search via MCP
   * Used by SearchManager for vector-based search
   */
  async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
    await this.ensureCollectionExists();

    try {
      const chromaMcp = ChromaMcpManager.getInstance();
      const results = await chromaMcp.callTool('chroma_query_documents', {
        collection_name: this.collectionName,
        query_texts: [query],
        n_results: limit,
        ...(whereFilter && { where: whereFilter }),
        include: ['documents', 'metadatas', 'distances']
      }) as any;

      // chroma_query_documents returns nested arrays (one per query text)
      // We always pass a single query text, so we access [0]
      const ids: number[] = [];
      const seen = new Set<number>();
      const docIds = results?.ids?.[0] || [];
      const rawMetadatas = results?.metadatas?.[0] || [];
      const rawDistances = results?.distances?.[0] || [];

      // Build deduplicated arrays that stay index-aligned:
      // Multiple Chroma docs map to the same SQLite ID (one per field).
      // Keep the first (best-ranked) distance and metadata per SQLite ID.
      const metadatas: any[] = [];
      const distances: number[] = [];

      for (let i = 0; i < docIds.length; i++) {
        const docId = docIds[i];
        // Extract sqlite_id from document ID (supports three formats):
        // - obs_{id}_narrative, obs_{id}_fact_0, etc (observations)
        // - summary_{id}_request, summary_{id}_learned, etc (session summaries)
        // - prompt_{id} (user prompts)
        const obsMatch = docId.match(/obs_(\d+)_/);
        const summaryMatch = docId.match(/summary_(\d+)_/);
        const promptMatch = docId.match(/prompt_(\d+)/);

        let sqliteId: number | null = null;
        if (obsMatch) {
          sqliteId = parseInt(obsMatch[1], 10);
        } else if (summaryMatch) {
          sqliteId = parseInt(summaryMatch[1], 10);
        } else if (promptMatch) {
          sqliteId = parseInt(promptMatch[1], 10);
        }

        if (sqliteId !== null && !seen.has(sqliteId)) {
          seen.add(sqliteId);
          ids.push(sqliteId);
          metadatas.push(rawMetadatas[i] ?? null);
          distances.push(rawDistances[i] ?? 0);
        }
      }

      return { ids, distances, metadatas };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for connection errors
      const isConnectionError =
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('fetch failed') ||
        errorMessage.includes('subprocess closed') ||
        errorMessage.includes('timed out');

      if (isConnectionError) {
        // Reset collection state so next call attempts reconnect
        this.collectionCreated = false;
        logger.error('CHROMA_SYNC', 'Connection lost during query',
          { collection: this.collectionName, query }, error as Error);
        throw new Error(`Chroma query failed - connection lost: ${errorMessage}`);
      }

      logger.error('CHROMA_SYNC', 'Query failed', { collection: this.collectionName, query }, error as Error);
      throw error;
    }
  }

  /**
   * Backfill all enabled projects from the allowlist.
   * Each project gets its own ChromaSync instance (via DatabaseManager pool)
   * and reads from its own per-project SQLite DB.
   * Designed to be called fire-and-forget on worker startup.
   */
  static async backfillAllProjects(dbManager: DatabaseManager): Promise<void> {
    // Dynamic imports avoid circular dependency: DatabaseManager → ChromaSync → DatabaseManager.
    // `import type` at top is compiled away; these runtime imports only execute here.
    const { listEnabledProjects } = await import('../../shared/project-allowlist.js');
    const { resolveProjectDbPath } = await import('../../shared/paths.js');

    const enabledProjects = listEnabledProjects();
    const projectRoots = Object.keys(enabledProjects);

    logger.info('CHROMA_SYNC', `Backfill check for ${projectRoots.length} enabled projects`);

    for (const projectRoot of projectRoots) {
      try {
        const dbPath = resolveProjectDbPath(projectRoot);
        const chromaSync = dbManager.getChromaSync(dbPath);
        if (!chromaSync) {
          logger.debug('CHROMA_SYNC', `Skipping backfill for ${projectRoot} (Chroma unavailable)`);
          continue;
        }
        const sessionStore = dbManager.getSessionStore(dbPath);
        await chromaSync.ensureBackfilled(sessionStore);
      } catch (error) {
        logger.error('CHROMA_SYNC', `Backfill failed for project: ${projectRoot}`, {}, error as Error);
      }
    }
  }

  /**
   * Close the ChromaSync instance
   * ChromaMcpManager is a singleton and manages its own lifecycle
   * We don't close it here - it's closed during graceful shutdown
   */
  async close(): Promise<void> {
    // ChromaMcpManager is a singleton and manages its own lifecycle
    // We don't close it here - it's closed during graceful shutdown
    logger.info('CHROMA_SYNC', 'ChromaSync closed', { collection: this.collectionName });
  }
}
