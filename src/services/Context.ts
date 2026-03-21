/**
 * Context - Named re-export facade
 *
 * Provides a clean import path for context generation functionality.
 * Import from './Context.js' or './context/index.js'.
 */

export { generateContext } from './context/ContextBuilder.js';
export type { ContextInput, ContextConfig } from './context/types.js';
