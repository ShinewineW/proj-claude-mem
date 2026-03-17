import React, { useState } from 'react';
import { Badge } from './Badge';
import { formatDate } from '../utils/formatters';
import type { FeedItem } from '../types';

interface DetailCardProps {
  item: FeedItem;
}

/**
 * Resolve the CSS type-tint class for a detail card based on item type.
 *
 * Observation subtypes map to specific tints; everything else falls back
 * to the discovery (blue) tint.
 */
function getTypeClass(item: FeedItem): string {
  switch (item.itemType) {
    case 'observation': {
      const subtype = item.type;
      if (subtype === 'change') return 'type-ob-change';
      if (subtype === 'feature') return 'type-ob-feature';
      // discovery, bugfix, refactor, decision all get the blue fallback
      return 'type-ob-discovery';
    }
    case 'summary':
      return 'type-summary';
    case 'prompt':
      return 'type-prompt';
  }
}

/** Safely parse a JSON string into an array of strings. */
function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Summary Section Icons ───────────────────────────────────────────

const SUMMARY_SECTIONS = [
  { key: 'investigated', label: 'Investigated', icon: 'icon-thick-investigated.svg' },
  { key: 'learned', label: 'Learned', icon: 'icon-thick-learned.svg' },
  { key: 'completed', label: 'Completed', icon: 'icon-thick-completed.svg' },
  { key: 'next_steps', label: 'Next Steps', icon: 'icon-thick-next-steps.svg' },
] as const;

/**
 * Renders summary-specific sections (investigated, learned, completed, next_steps)
 * with SVG icons and styled labels.
 */
function SummarySections({ item }: { item: FeedItem & { itemType: 'summary' } }) {
  const sections: Array<{ label: string; content: string; icon: string }> = [];

  for (const s of SUMMARY_SECTIONS) {
    const value = item[s.key as keyof typeof item] as string | undefined;
    if (value) {
      sections.push({ label: s.label, content: value, icon: s.icon });
    }
  }

  if (sections.length === 0) return null;

  return (
    <>
      {sections.map(s => (
        <div key={s.label} style={{ marginTop: 16 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 6,
          }}>
            <img
              src={s.icon}
              alt=""
              style={{ width: 16, height: 16, flexShrink: 0, opacity: 0.85 }}
            />
            <span style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--color-text)',
              fontFamily: 'var(--font-heading)',
              letterSpacing: '-0.2px',
            }}>
              {s.label}
            </span>
          </div>
          <div className="detail-card-text" style={{ paddingLeft: 22 }}>{s.content}</div>
        </div>
      ))}
    </>
  );
}

// ─── Observation Subtype Badge ───────────────────────────────────────

const SUBTYPE_COLORS: Record<string, { bg: string; text: string }> = {
  discovery: { bg: 'rgba(219,234,254,0.7)', text: '#1E40AF' },
  change:    { bg: 'rgba(254,243,199,0.7)', text: '#92400E' },
  feature:   { bg: 'rgba(220,252,231,0.7)', text: '#166534' },
  bugfix:    { bg: 'rgba(254,226,226,0.7)', text: '#991B1B' },
  refactor:  { bg: 'rgba(237,233,254,0.7)', text: '#5B21B6' },
  decision:  { bg: 'rgba(255,237,213,0.7)', text: '#9A3412' },
};

function SubtypeBadge({ subtype }: { subtype: string }) {
  const colors = SUBTYPE_COLORS[subtype] ?? SUBTYPE_COLORS.discovery;
  return (
    <span style={{
      display: 'inline-block',
      fontSize: 10,
      fontWeight: 600,
      fontFamily: 'var(--font-badge)',
      textTransform: 'uppercase',
      letterSpacing: '0.4px',
      padding: '2px 6px',
      borderRadius: 'var(--radius-badge)',
      background: colors.bg,
      color: colors.text,
    }}>
      {subtype}
    </span>
  );
}

// ─── File List ───────────────────────────────────────────────────────

function FileList({ label, files }: { label: string; files: string[] }) {
  if (files.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--color-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        marginBottom: 4,
        fontFamily: 'var(--font-heading)',
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {files.map((f, i) => (
          <span key={i} style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text-secondary)',
            background: 'rgba(203,213,225,0.2)',
            padding: '2px 6px',
            borderRadius: 4,
            wordBreak: 'break-all',
          }}>
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Concept Tags ────────────────────────────────────────────────────

function ConceptTags({ concepts }: { concepts: string[] }) {
  if (concepts.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--color-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        marginBottom: 4,
        fontFamily: 'var(--font-heading)',
      }}>
        Concepts
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {concepts.map((c, i) => (
          <span key={i} style={{
            fontSize: 11,
            fontFamily: 'var(--font-badge)',
            fontWeight: 500,
            color: 'var(--badge-ob-text)',
            background: 'var(--badge-ob-bg)',
            padding: '2px 8px',
            borderRadius: 10,
          }}>
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Card Footer ─────────────────────────────────────────────────────

function CardFooter({ id, epoch }: { id: number; epoch: number }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 14,
      paddingTop: 10,
      borderTop: '1px solid rgba(203,213,225,0.25)',
      fontSize: 11,
      color: 'var(--color-text-muted)',
      fontFamily: 'var(--font-mono)',
    }}>
      <span>#{id}</span>
      <span>{formatDate(epoch)}</span>
    </div>
  );
}

// ─── Observation Detail ──────────────────────────────────────────────

function ObservationDetail({ item }: { item: FeedItem & { itemType: 'observation' } }) {
  const [view, setView] = useState<'facts' | 'narrative'>('facts');

  const facts = parseJsonArray(item.facts);
  const concepts = parseJsonArray(item.concepts);
  const filesRead = parseJsonArray(item.files_read);
  const filesModified = parseJsonArray(item.files_modified);
  const hasNarrative = !!item.narrative;
  const hasFacts = facts.length > 0;
  const hasToggle = hasFacts && hasNarrative;

  return (
    <>
      {/* Subtitle */}
      {item.subtitle && (
        <div style={{
          fontSize: 12,
          color: 'var(--color-text-secondary)',
          marginBottom: 8,
          lineHeight: 1.5,
        }}>
          {item.subtitle}
        </div>
      )}

      {/* Facts / Narrative Toggle */}
      {hasToggle && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
          <button
            onClick={() => setView('facts')}
            style={{
              fontSize: 11,
              fontWeight: view === 'facts' ? 600 : 400,
              fontFamily: 'var(--font-heading)',
              padding: '3px 10px',
              borderRadius: 6,
              border: '1px solid',
              borderColor: view === 'facts' ? 'var(--color-border-active)' : 'var(--color-border)',
              background: view === 'facts' ? 'rgba(255,255,255,0.5)' : 'transparent',
              color: view === 'facts' ? 'var(--color-text)' : 'var(--color-text-muted)',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            Facts
          </button>
          <button
            onClick={() => setView('narrative')}
            style={{
              fontSize: 11,
              fontWeight: view === 'narrative' ? 600 : 400,
              fontFamily: 'var(--font-heading)',
              padding: '3px 10px',
              borderRadius: 6,
              border: '1px solid',
              borderColor: view === 'narrative' ? 'var(--color-border-active)' : 'var(--color-border)',
              background: view === 'narrative' ? 'rgba(255,255,255,0.5)' : 'transparent',
              color: view === 'narrative' ? 'var(--color-text)' : 'var(--color-text-muted)',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            Narrative
          </button>
        </div>
      )}

      {/* Facts view */}
      {(view === 'facts' || !hasToggle) && hasFacts && (
        <ul style={{
          margin: 0,
          paddingLeft: 18,
          fontSize: 13,
          color: 'var(--color-text-secondary)',
          lineHeight: 1.7,
          listStyleType: 'disc',
        }}>
          {facts.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      )}

      {/* Narrative view */}
      {(view === 'narrative' || (!hasFacts && hasNarrative)) && (
        <div className="detail-card-text">{item.narrative}</div>
      )}

      {/* Fallback to text if no facts or narrative */}
      {!hasFacts && !hasNarrative && item.text && (
        <div className="detail-card-text">{item.text}</div>
      )}

      {/* Concepts */}
      <ConceptTags concepts={concepts} />

      {/* Files */}
      <FileList label="Files Read" files={filesRead} />
      <FileList label="Files Modified" files={filesModified} />

      {/* Footer */}
      <CardFooter id={item.id} epoch={item.created_at_epoch} />
    </>
  );
}

// ─── Summary Detail ──────────────────────────────────────────────────

function SummaryDetail({ item }: { item: FeedItem & { itemType: 'summary' } }) {
  const filesRead = parseJsonArray(item.files_read);
  const filesEdited = parseJsonArray(item.files_edited);

  return (
    <>
      {/* Request as prominent title */}
      {item.request && (
        <div style={{
          fontSize: 15,
          fontWeight: 700,
          color: 'var(--color-text)',
          fontFamily: 'var(--font-heading)',
          marginBottom: 4,
          lineHeight: 1.4,
        }}>
          {item.request}
        </div>
      )}

      {/* Sections with icons */}
      <SummarySections item={item} />

      {/* Notes */}
      {item.notes && (
        <div style={{ marginTop: 12 }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            marginBottom: 4,
            fontFamily: 'var(--font-heading)',
          }}>
            Notes
          </div>
          <div className="detail-card-text">{item.notes}</div>
        </div>
      )}

      {/* Files */}
      <FileList label="Files Read" files={filesRead} />
      <FileList label="Files Edited" files={filesEdited} />

      {/* Footer */}
      <CardFooter id={item.id} epoch={item.created_at_epoch} />
    </>
  );
}

// ─── Prompt Detail ───────────────────────────────────────────────────

function PromptDetail({ item }: { item: FeedItem & { itemType: 'prompt' } }) {
  return (
    <>
      {/* Prompt number */}
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--color-text-muted)',
        fontFamily: 'var(--font-heading)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        marginBottom: 6,
      }}>
        Prompt #{item.prompt_number}
      </div>

      {/* Full prompt text */}
      <div className="detail-card-text" style={{ whiteSpace: 'pre-wrap' }}>
        {item.prompt_text}
      </div>

      {/* Footer */}
      <CardFooter id={item.id} epoch={item.created_at_epoch} />
    </>
  );
}

// ─── Main DetailCard ─────────────────────────────────────────────────

export function DetailCard({ item }: DetailCardProps) {
  const typeClass = getTypeClass(item);

  return (
    <div className={`detail-card ${typeClass}`}>
      {/* Header: badge + optional subtype badge */}
      <div className="detail-card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Badge type={item.itemType} />
          {item.itemType === 'observation' && (
            <SubtypeBadge subtype={item.type} />
          )}
        </div>
      </div>

      {/* Title for observations */}
      {item.itemType === 'observation' && item.title && (
        <div className="detail-card-title">{item.title}</div>
      )}

      {/* Type-specific content */}
      {item.itemType === 'observation' && <ObservationDetail item={item} />}
      {item.itemType === 'summary' && <SummaryDetail item={item} />}
      {item.itemType === 'prompt' && <PromptDetail item={item} />}
    </div>
  );
}
