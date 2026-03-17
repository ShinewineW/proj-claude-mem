import React from 'react';
import { Badge } from './Badge';
import { formatShortTime } from '../utils/formatters';
import type { FeedItem } from '../types';

interface RecentFeedProps {
  items: FeedItem[];
}

function getFeedText(item: FeedItem): string {
  switch (item.itemType) {
    case 'observation':
      return item.title || item.subtitle || item.text || '';
    case 'summary':
      return item.request || 'Session Summary';
    case 'prompt':
      return item.prompt_text;
  }
}

function getFeedProject(item: FeedItem): string {
  return item.project;
}

function getBadgeType(item: FeedItem): 'observation' | 'summary' | 'prompt' {
  return item.itemType;
}

export function RecentFeed({ items }: RecentFeedProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="live-feed">
      <div className="feed-header">
        <div className="section-title" style={{ marginBottom: 0 }}>Recent Activity</div>
        <div className="live-indicator">
          <span className="live-dot" />
          live
        </div>
      </div>
      <div className="feed-list">
        {items.map(item => (
          <div className="feed-item" key={`${item.itemType}-${item.id}`}>
            <Badge type={getBadgeType(item)} />
            <span className="feed-project">{getFeedProject(item)}</span>
            <span className="feed-text">{getFeedText(item)}</span>
            <span className="feed-time">{formatShortTime(item.created_at_epoch)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
