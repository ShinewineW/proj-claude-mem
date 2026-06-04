/**
 * TimelineRenderer - Renders the chronological timeline of observations and summaries
 *
 * Handles day grouping, file grouping within days, and table rendering.
 */

import type {
  ContextConfig,
  Observation,
  TimelineItem,
  SummaryTimelineItem,
} from '../types.js';
import { formatTime, formatDate, formatDateTime, extractFirstFile, parseJsonArray } from '../../../shared/timeline-formatting.js';
import * as Markdown from '../formatters/MarkdownFormatter.js';
import * as Color from '../formatters/ColorFormatter.js';

/**
 * Group timeline items by day
 */
export function groupTimelineByDay(timeline: TimelineItem[]): Map<string, TimelineItem[]> {
  const itemsByDay = new Map<string, TimelineItem[]>();

  for (const item of timeline) {
    const itemDate = item.type === 'observation' ? item.data.created_at : item.data.displayTime;
    const day = formatDate(itemDate);
    if (!itemsByDay.has(day)) {
      itemsByDay.set(day, []);
    }
    itemsByDay.get(day)!.push(item);
  }

  // Sort days chronologically
  const sortedEntries = Array.from(itemsByDay.entries()).sort((a, b) => {
    const aDate = new Date(a[0]).getTime();
    const bDate = new Date(b[0]).getTime();
    return aDate - bDate;
  });

  return new Map(sortedEntries);
}

/**
 * Get detail field content for full observation display
 */
function getDetailField(obs: Observation, config: ContextConfig): string | null {
  if (config.fullObservationField === 'narrative') {
    return obs.narrative;
  }
  return obs.facts ? parseJsonArray(obs.facts).join('\n') : null;
}

/**
 * Render a single day's timeline items (markdown/LLM mode - flat compact lines)
 *
 * Note: the markdown path intentionally has NO file grouping (unlike the color
 * path below). Context is flat lines; file info lives in the observation titles,
 * so there is no `currentFile` tracking here on purpose.
 */
function renderDayTimelineMarkdown(
  day: string,
  dayItems: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig,
): string[] {
  const output: string[] = [];

  output.push(...Markdown.renderMarkdownDayHeader(day));

  let lastTime = '';

  for (const item of dayItems) {
    if (item.type === 'summary') {
      lastTime = '';

      const summary = item.data as SummaryTimelineItem;
      // formatDateTime returns a verbose "Mon DD, H:MM AM/PM"; renderMarkdownSummaryItem
      // compacts it via compactTime so summary times match the flat row times.
      const formattedTime = formatDateTime(summary.displayTime);
      output.push(...Markdown.renderMarkdownSummaryItem(summary, formattedTime));
    } else {
      const obs = item.data as Observation;
      const time = formatTime(obs.created_at);
      const showTime = time !== lastTime;
      const timeDisplay = showTime ? time : '';
      lastTime = time;

      const shouldShowFull = fullObservationIds.has(obs.id);

      if (shouldShowFull) {
        const detailField = getDetailField(obs, config);
        output.push(...Markdown.renderMarkdownFullObservation(obs, timeDisplay, detailField, config));
      } else {
        output.push(Markdown.renderMarkdownTableRow(obs, timeDisplay, config));
      }
    }
  }

  return output;
}

/**
 * Render a single day's timeline items (color/terminal mode - file grouped with tables)
 */
function renderDayTimelineColor(
  day: string,
  dayItems: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig,
  cwd: string,
): string[] {
  const output: string[] = [];

  output.push(...Color.renderColorDayHeader(day));

  let currentFile: string | null = null;
  let lastTime = '';

  for (const item of dayItems) {
    if (item.type === 'summary') {
      currentFile = null;
      lastTime = '';

      const summary = item.data as SummaryTimelineItem;
      const formattedTime = formatDateTime(summary.displayTime);
      output.push(...Color.renderColorSummaryItem(summary, formattedTime));
    } else {
      const obs = item.data as Observation;
      const file = extractFirstFile(obs.files_modified, cwd, obs.files_read);
      const time = formatTime(obs.created_at);
      const showTime = time !== lastTime;
      lastTime = time;

      const shouldShowFull = fullObservationIds.has(obs.id);

      if (file !== currentFile) {
        output.push(...Color.renderColorFileHeader(file));
        currentFile = file;
      }

      if (shouldShowFull) {
        const detailField = getDetailField(obs, config);
        output.push(...Color.renderColorFullObservation(obs, time, showTime, detailField, config));
      } else {
        output.push(Color.renderColorTableRow(obs, time, showTime, config));
      }
    }
  }

  output.push('');

  return output;
}

/**
 * Render a single day's timeline items
 */
export function renderDayTimeline(
  day: string,
  dayItems: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig,
  cwd: string,
  useColors: boolean
): string[] {
  if (useColors) {
    return renderDayTimelineColor(day, dayItems, fullObservationIds, config, cwd);
  }
  return renderDayTimelineMarkdown(day, dayItems, fullObservationIds, config);
}

/**
 * Render the complete timeline
 */
export function renderTimeline(
  timeline: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig,
  cwd: string,
  useColors: boolean
): string[] {
  const output: string[] = [];
  const itemsByDay = groupTimelineByDay(timeline);

  for (const [day, dayItems] of itemsByDay) {
    output.push(...renderDayTimeline(day, dayItems, fullObservationIds, config, cwd, useColors));
  }

  return output;
}
