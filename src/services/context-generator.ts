/**
 * Context Generator - DEPRECATED
 *
 * This file is the build entry for the context-generator bundle and re-exports
 * the live implementation. New code should import from './context/ContextBuilder.js'.
 *
 * The context generation logic has been restructured into:
 * - src/services/context/ContextBuilder.ts - Main orchestrator
 * - src/services/context/ContextConfigLoader.ts - Configuration loading
 * - src/services/context/TokenCalculator.ts - Token economics
 * - src/services/context/ObservationCompiler.ts - Data retrieval
 * - src/services/context/formatters/ - Output formatting
 * - src/services/context/sections/ - Section rendering
 */
// Re-export everything from the new context module
export { generateContext } from './context/ContextBuilder.js';
export type { ContextInput, ContextConfig } from './context/types.js';
