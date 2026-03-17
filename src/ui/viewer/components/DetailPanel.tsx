import React, { useEffect, useRef, useCallback } from 'react';
import { DetailCard } from './DetailCard';
import { useDetailPagination } from '../hooks/useDetailPagination';
import { UI } from '../constants/ui';
import type { ProjectInfo } from '../types';

interface DetailPanelProps {
  project: ProjectInfo | null;
  onClose: () => void;
}

/**
 * Slide-in panel showing a chronological feed of all items for a single project.
 *
 * Uses IntersectionObserver on a sentinel div to trigger infinite scroll.
 * Closes on overlay click, ESC key, or X button.
 */
export function DetailPanel({ project, onClose }: DetailPanelProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { items, loadMore, hasMore, isLoading } = useDetailPagination(
    project?.project ?? null,
    project?.dbPath ?? '',
  );

  // ESC key closes panel
  useEffect(() => {
    if (!project) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [project, onClose]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    if (!project) return;

    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMore && !isLoading) {
          loadMore();
        }
      },
      { threshold: UI.LOAD_MORE_THRESHOLD },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [project, hasMore, isLoading, loadMore]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    // Only close if clicking the overlay itself, not the panel
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);

  if (!project) return null;

  return (
    <div className="detail-overlay open" onClick={handleOverlayClick}>
      <div className="detail-panel" onClick={e => e.stopPropagation()}>
        <div className="detail-header">
          <div>
            <div className="project-name" style={{ fontSize: 18 }}>{project.project}</div>
            <div className="project-path" style={{ maxWidth: 400 }}>{project.projectRoot.replace(/^\/Users\/[^/]+/, '~')}</div>
          </div>
          <button className="detail-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="detail-content">
          {items.map(item => (
            <DetailCard key={`${item.itemType}-${item.id}`} item={item} />
          ))}

          {/* Sentinel for IntersectionObserver */}
          <div ref={sentinelRef} style={{ height: 1 }} />

          {isLoading && (
            <div className="load-more" style={{ cursor: 'default' }}>Loading...</div>
          )}
          {hasMore && !isLoading && (
            <div className="load-more" onClick={loadMore}>Load more...</div>
          )}
          {!hasMore && items.length > 0 && (
            <div className="load-more" style={{ cursor: 'default' }}>No more items</div>
          )}
          {!isLoading && items.length === 0 && (
            <div className="load-more" style={{ cursor: 'default' }}>No items yet</div>
          )}
        </div>
      </div>
    </div>
  );
}
