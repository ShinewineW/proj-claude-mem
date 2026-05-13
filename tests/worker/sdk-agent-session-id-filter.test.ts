import { describe, expect, it } from "bun:test";
import { shouldPersistSDKSessionId } from "../../src/services/worker/SDKAgent.js";

describe("SDKAgent session_id persistence gate", () => {
  it("ignores system:hook_* session ids before they can update memorySessionId", () => {
    const currentMemorySessionId = "canonical-session";

    for (const subtype of ["hook_started", "hook_progress", "hook_response"]) {
      expect(
        shouldPersistSDKSessionId(
          {
            type: "system",
            subtype,
            session_id: `ephemeral-${subtype}`,
          },
          currentMemorySessionId,
        ),
      ).toBe(false);
    }
  });

  it("allows canonical non-hook SDK session ids to be captured", () => {
    expect(
      shouldPersistSDKSessionId(
        {
          type: "system",
          subtype: "init",
          session_id: "canonical-session",
        },
        null,
      ),
    ).toBe(true);

    expect(
      shouldPersistSDKSessionId(
        {
          type: "assistant",
          session_id: "canonical-session",
        },
        null,
      ),
    ).toBe(true);

    expect(
      shouldPersistSDKSessionId(
        {
          type: "result",
          subtype: "success",
          session_id: "canonical-session",
        },
        null,
      ),
    ).toBe(true);
  });

  it("does not rewrite the database when the SDK repeats the current memorySessionId", () => {
    expect(
      shouldPersistSDKSessionId(
        {
          type: "system",
          subtype: "init",
          session_id: "already-current",
        },
        "already-current",
      ),
    ).toBe(false);
  });
});
