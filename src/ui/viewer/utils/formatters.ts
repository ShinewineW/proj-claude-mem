/**
 * Formatting utility functions
 * Used across UI components for consistent display
 */

/**
 * Format epoch timestamp to locale string
 * @param epoch - Timestamp in milliseconds since epoch
 * @returns Formatted date string
 */
export function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleString();
}

/**
 * Format epoch to short time string for feed items.
 * Today: "14:32", this year: "3/17 14:32", older: "2025/3/17"
 */
export function formatShortTime(epoch: number): string {
  const date = new Date(epoch);
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');

  if (date.toDateString() === now.toDateString()) {
    return `${hh}:${mm}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

