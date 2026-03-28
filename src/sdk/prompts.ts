/**
 * SDK Prompts Module
 * Generates prompts for the Claude Agent SDK memory worker
 */

import { logger } from "../utils/logger.js";
import type { ModeConfig } from "../services/domain/types.js";

export interface Observation {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  created_at_epoch: number;
  cwd?: string;
}

export interface SDKSession {
  id: number;
  memory_session_id: string | null;
  project: string;
  user_prompt: string;
  last_assistant_message?: string;
}

/**
 * Build initial prompt to initialize the SDK agent
 */
export function buildInitPrompt(
  project: string,
  sessionId: string,
  userPrompt: string,
  mode: ModeConfig,
): string {
  return `${mode.prompts.system_identity}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split("T")[0]}</requested_at>
</observed_from_primary_session>

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${mode.prompts.output_format_header}

\`\`\`xml
<observation>
  <type>[ ${mode.observation_types.map((t) => t.id).join(" | ")} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <!--
    ${mode.prompts.concept_guidance}
  -->
  <files_read>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_read>
  <files_modified>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_modified>
</observation>
\`\`\`
${mode.prompts.format_examples}

${mode.prompts.footer}

${mode.prompts.header_memory_start}`;
}

/**
 * Truncate a string field with head/tail preservation.
 * Head: first 30% of limit, Tail: last 20% of limit (total 50% kept).
 */
function truncateField(content: string, maxChars: number): { text: string; wasTruncated: boolean } {
  if (content.length <= maxChars) return { text: content, wasTruncated: false };
  const headSize = Math.floor(maxChars * 0.3);
  const tailSize = Math.floor(maxChars * 0.2);
  const truncated = content.length - headSize - tailSize;
  return {
    text: content.slice(0, headSize) +
      `\n[... truncated ${truncated} chars ...]\n` +
      content.slice(-tailSize),
    wasTruncated: true,
  };
}

/**
 * Render a single observation's XML block (shared by single and batch prompts).
 * @param index — 1-based index for batch mode; omit for single mode.
 */
function renderObservationBlock(
  obs: Observation,
  maxFieldChars: number,
  index?: number,
): { block: string; truncatedFields: number } {
  const timestamp = new Date(obs.created_at_epoch).toISOString();
  let truncatedFields = 0;

  // tool_input: parse JSON string → compact JSON
  let inputStr: string;
  try {
    inputStr = JSON.stringify(JSON.parse(obs.tool_input));
  } catch {
    inputStr = obs.tool_input || "{}";
  }
  const inputResult = truncateField(inputStr, maxFieldChars);
  inputStr = inputResult.text;
  if (inputResult.wasTruncated) truncatedFields++;

  // tool_output: parse JSON string → prefer plain text rendering
  let outcomeStr: string;
  try {
    const parsedOutput = JSON.parse(obs.tool_output);
    if (typeof parsedOutput === "string") {
      outcomeStr = parsedOutput; // plain text (file content, terminal output)
    } else {
      outcomeStr = JSON.stringify(parsedOutput); // compact object fallback
    }
  } catch {
    outcomeStr = obs.tool_output || "";
  }
  const outputResult = truncateField(outcomeStr, maxFieldChars);
  outcomeStr = outputResult.text;
  if (outputResult.wasTruncated) truncatedFields++;

  const indexAttr = index !== undefined ? ` index="${index}"` : "";
  let block = `<observed_from_primary_session${indexAttr}>
  <what_happened>${obs.tool_name}</what_happened>
  <occurred_at>${timestamp}</occurred_at>`;
  if (obs.cwd) {
    block += `\n  <working_directory>${obs.cwd}</working_directory>`;
  }
  block += `
  <parameters>
${inputStr}
  </parameters>
  <outcome>
${outcomeStr}
  </outcome>
</observed_from_primary_session>`;
  return { block, truncatedFields };
}

/**
 * Build prompt to send tool observation to SDK agent
 */
export function buildObservationPrompt(
  obs: Observation,
  maxFieldChars: number = 8000,
): { prompt: string; truncatedFields: number } {
  const { block, truncatedFields } = renderObservationBlock(obs, maxFieldChars);
  const prompt = `--- OBSERVATION ONLY ---
Do NOT output <summary> tags. This is an observation, not a summary request.
Your response MUST use <observation> tags ONLY. Any <summary> output will be discarded.

${block}`;
  return { prompt, truncatedFields };
}

/**
 * Build a batch observation prompt for multiple observations.
 * Single observation: delegates to buildObservationPrompt (backward-compatible).
 * Multiple: wraps in batch format with indexed items.
 */
export function buildBatchObservationPrompt(
  observations: Observation[],
  maxFieldChars: number = 8000,
): { prompt: string; truncatedFields: number } {
  if (observations.length === 0) return { prompt: "", truncatedFields: 0 };
  if (observations.length === 1) {
    return buildObservationPrompt(observations[0], maxFieldChars);
  }

  let totalTruncatedFields = 0;
  let prompt = `--- OBSERVATION BATCH (${observations.length} items) ---
Do NOT output <summary> tags. These are observations, not a summary request.
Your response MUST use <observation> tags ONLY.
Output 0 or more observations — skip items that are not noteworthy.\n\n`;

  for (let i = 0; i < observations.length; i++) {
    const { block, truncatedFields } = renderObservationBlock(observations[i], maxFieldChars, i + 1);
    totalTruncatedFields += truncatedFields;
    prompt += block + "\n\n";
  }

  return { prompt, truncatedFields: totalTruncatedFields };
}

/**
 * Build prompt to generate progress summary
 */
export function buildSummaryPrompt(
  session: SDKSession,
  mode: ModeConfig,
): string {
  const lastAssistantMessage =
    session.last_assistant_message ||
    (() => {
      logger.error(
        "SDK",
        "Missing last_assistant_message in session for summary prompt",
        {
          sessionId: session.id,
        },
      );
      return "";
    })();

  return `--- MODE SWITCH: PROGRESS SUMMARY ---
Do NOT output <observation> tags. This is a summary request, not an observation request.
Your response MUST use <summary> tags ONLY. Any <observation> output will be discarded.

${mode.prompts.header_summary_checkpoint}
${mode.prompts.summary_instruction}

${mode.prompts.summary_context_label}
${lastAssistantMessage}

${mode.prompts.summary_format_instruction}
<summary>
  <request>${mode.prompts.xml_summary_request_placeholder}</request>
  <investigated>${mode.prompts.xml_summary_investigated_placeholder}</investigated>
  <learned>${mode.prompts.xml_summary_learned_placeholder}</learned>
  <completed>${mode.prompts.xml_summary_completed_placeholder}</completed>
  <next_steps>${mode.prompts.xml_summary_next_steps_placeholder}</next_steps>
  <notes>${mode.prompts.xml_summary_notes_placeholder}</notes>
</summary>

${mode.prompts.summary_footer}`;
}

/**
 * Build prompt for continuation of existing session
 *
 * CRITICAL: Why contentSessionId Parameter is Required
 * ====================================================
 * This function receives contentSessionId from SDKAgent.ts, which comes from:
 * - SessionManager.initializeSession (fetched from database)
 * - SessionStore.createSDKSession (stored by new-hook.ts)
 * - new-hook.ts receives it from Claude Code's hook context
 *
 * The contentSessionId is the SAME session_id used by:
 * - NEW hook (to create/fetch session)
 * - SAVE hook (to store observations)
 * - This continuation prompt (to maintain session context)
 *
 * This is how everything stays connected - ONE session_id threading through
 * all hooks and prompts in the same conversation.
 *
 * Called when: promptNumber > 1 (see SDKAgent.ts line 150)
 * First prompt: Uses buildInitPrompt instead (promptNumber === 1)
 */
export function buildContinuationPrompt(
  userPrompt: string,
  promptNumber: number,
  contentSessionId: string,
  mode: ModeConfig,
): string {
  return `${mode.prompts.continuation_greeting}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split("T")[0]}</requested_at>
</observed_from_primary_session>

${mode.prompts.system_identity}

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${mode.prompts.continuation_instruction}

${mode.prompts.output_format_header}

\`\`\`xml
<observation>
  <type>[ ${mode.observation_types.map((t) => t.id).join(" | ")} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <!--
    ${mode.prompts.concept_guidance}
  -->
  <files_read>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_read>
  <files_modified>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_modified>
</observation>
\`\`\`
${mode.prompts.format_examples}

${mode.prompts.footer}

${mode.prompts.header_memory_continued}`;
}

/**
 * Build a compact summary of prior observations for injection after forceInit.
 * Called when the SDK session is reset due to context overflow — provides
 * continuity by listing what was observed before the reset.
 *
 * @param observations - Observation rows from getObservationsForSession()
 * @returns XML block string, or empty string if no observations
 */
export function buildSessionHistorySummary(
  observations: Array<{
    type: string;
    title: string | null;
    subtitle: string | null;
    prompt_number: number | null;
  }>,
): string {
  if (observations.length === 0) return "";

  const lines = observations.map((obs, i) => {
    const displayTitle = obs.title || "(untitled)";
    return `  ${i + 1}. [${obs.type}] ${displayTitle}`;
  });

  return `<session_history_summary>
  Prior observations (conversation reset for context management):
${lines.join("\n")}
</session_history_summary>`;
}
