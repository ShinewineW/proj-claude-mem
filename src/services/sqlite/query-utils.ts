/**
 * Shared query utilities for SQLite operations
 */

/**
 * Validate that a limit parameter is a positive integer.
 * Used by all getByIds query functions to ensure data integrity.
 */
export function assertValidLimit(limit: number | undefined | null): void {
  if (limit !== undefined && limit !== null) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      throw new Error('Invalid limit: must be a positive integer');
    }
  }
}
