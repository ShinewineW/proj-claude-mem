import { describe, test, expect } from "bun:test";
import { classifyBypassFailure } from "../../src/services/worker/BypassLane.js";

describe("classifyBypassFailure", () => {
  test("bare 429 -> ratelimit (not quota)", () => {
    expect(classifyBypassFailure(429, {})).toBe("ratelimit");
  });
  test("429 with insufficient_quota body -> quota", () => {
    expect(classifyBypassFailure(429, { code: "insufficient_quota" })).toBe("quota");
  });
  test("402 -> quota", () => {
    expect(classifyBypassFailure(402, {})).toBe("quota");
  });
  test("401/403 -> auth", () => {
    expect(classifyBypassFailure(401, {})).toBe("auth");
    expect(classifyBypassFailure(403, {})).toBe("auth");
  });
  test("5xx -> transient", () => {
    expect(classifyBypassFailure(503, {})).toBe("transient");
  });
  test("400 -> client", () => {
    expect(classifyBypassFailure(400, {})).toBe("client");
  });
  test("ModelError envelope wins over status -> client", () => {
    expect(classifyBypassFailure(401, { type: "ModelError" })).toBe("client");
  });
});
