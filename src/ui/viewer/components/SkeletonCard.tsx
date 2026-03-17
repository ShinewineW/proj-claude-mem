import React from 'react';

export function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <div className="skel skel-title" />
      <div className="skel skel-path" />
      <div className="skel skel-line" />
      <div className="skel skel-line2" />
      <div className="skel-footer">
        <div className="skel skel-stat" />
        <div className="skel skel-stat" />
        <div className="skel skel-stat" />
      </div>
    </div>
  );
}
