// Non-source file extensions that are low-value under backpressure
const NON_SOURCE_EXTENSIONS = new Set([
  '.log', '.txt', '.json', '.yaml', '.yml', '.toml',
  '.env', '.lock', '.csv', '.xml', '.html', '.css',
  '.map', '.svg', '.png', '.jpg', '.gif', '.ico',
]);

export function getBackpressureLevel(
  pendingCount: number,
  l1Threshold: number,
  l2Threshold: number,
): 0 | 1 | 2 {
  if (pendingCount >= l2Threshold) return 2;
  if (pendingCount >= l1Threshold) return 1;
  return 0;
}

function extractTarget(toolName: string, toolInput: string): string {
  try {
    const parsed = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
    if (toolName === 'Read') return parsed?.file_path ?? '';
    if (toolName === 'Grep' || toolName === 'Glob') return parsed?.pattern ?? '';
    return '';
  } catch {
    return '';
  }
}

function isNonSourceFile(toolInput: string): boolean {
  try {
    const parsed = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
    const filePath: string = parsed?.file_path ?? '';
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    return NON_SOURCE_EXTENSIONS.has(ext.toLowerCase());
  } catch {
    return false;
  }
}

export function shouldSkipL1(
  toolName: string,
  toolInput: string,
  state: Record<string, unknown>,
): boolean {
  // Skip Read of non-source files
  if (toolName === 'Read' && isNonSourceFile(toolInput)) return true;

  // Skip duplicate tool+target
  const target = extractTarget(toolName, toolInput);
  if (state.lastEnqueuedTool === toolName && state.lastEnqueuedTarget === target) return true;

  // Track for dedup
  state.lastEnqueuedTool = toolName;
  state.lastEnqueuedTarget = target;
  return false;
}

export function shouldSkipL2(
  state: { backpressureCounter?: number },
  sampleRate: number,
): boolean {
  state.backpressureCounter = (state.backpressureCounter ?? 0) + 1;
  return state.backpressureCounter % sampleRate !== 0;
}

export function applyBackpressure(
  level: 0 | 1 | 2,
  toolName: string,
  toolInput: string,
  session: Record<string, unknown>,
  sampleRate: number,
): boolean {
  if (level === 1) return shouldSkipL1(toolName, toolInput, session);
  if (level === 2) return shouldSkipL2(session as { backpressureCounter?: number }, sampleRate);
  return false;
}
