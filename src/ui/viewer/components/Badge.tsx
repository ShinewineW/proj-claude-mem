import React from 'react';

type BadgeType = 'observation' | 'summary' | 'prompt';

interface BadgeProps {
  type: BadgeType;
}

const BADGE_CONFIG: Record<BadgeType, { text: string; className: string }> = {
  observation: { text: 'ob', className: 'badge-ob' },
  summary: { text: 'sum', className: 'badge-summary' },
  prompt: { text: 'ask', className: 'badge-prompt' },
};

export function Badge({ type }: BadgeProps) {
  const config = BADGE_CONFIG[type];
  return <span className={`badge ${config.className}`}>{config.text}</span>;
}
