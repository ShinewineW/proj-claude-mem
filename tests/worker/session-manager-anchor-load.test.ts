import { describe, test, expect } from "bun:test";
import { resolveInitialInMemoryAnchor } from "../../src/services/worker/SessionManager.js";

describe("resolveInitialInMemoryAnchor (Issue #817 + cm- anchor load)", () => {
  test("loads a cm- worker anchor from DB (stable, needed by bypass)", () => {
    expect(resolveInitialInMemoryAnchor("cm-1234")).toBe("cm-1234");
  });

  test("nulls a real SDK-id anchor (stale-resume prevention, unchanged)", () => {
    expect(resolveInitialInMemoryAnchor("550e8400-e29b-41d4-a716-446655440000")).toBeNull();
  });

  test("nulls when DB has no anchor", () => {
    expect(resolveInitialInMemoryAnchor(null)).toBeNull();
    expect(resolveInitialInMemoryAnchor(undefined)).toBeNull();
  });
});
