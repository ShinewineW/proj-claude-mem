import type { BypassInfo } from '../types';

export interface BypassBadgeView { label: string; tone: 'active' | 'tripped' | 'disabled'; title: string; }

export function bypassBadgeView(info: BypassInfo): BypassBadgeView {
  if (!info.endpoint && !info.model) {
    return { label: 'main (claude)', tone: 'disabled', title: `Bypass state: ${info.state ?? 'n/a'}` };
  }
  const label = `${info.endpoint ?? '?'}${info.model ? ' · ' + info.model : ''}`;
  const tone = info.state === 'ACTIVE' ? 'active' : info.state === 'TRIPPED' ? 'tripped' : 'disabled';
  const title = [`State: ${info.state ?? 'n/a'}`,
    info.consecutiveFailures ? `failures: ${info.consecutiveFailures}` : '',
    info.lastFailureReason ? `last: ${info.lastFailureReason}` : ''].filter(Boolean).join(' · ');
  return { label, tone, title };
}
