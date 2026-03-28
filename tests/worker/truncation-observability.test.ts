import { describe, test, expect } from "bun:test";
import { buildObservationPrompt, buildBatchObservationPrompt } from "../../src/sdk/prompts.js";

function makeObs(toolInput: string, toolOutput: string) {
  return {
    id: 1,
    tool_name: "Read",
    tool_input: toolInput,
    tool_output: toolOutput,
    created_at_epoch: Date.now(),
    cwd: "/tmp",
  };
}

describe("truncation telemetry type", () => {
  test("optimizationStats includes truncatedFields", () => {
    const stats: import("../../src/services/worker-types.js").ActiveSession["optimizationStats"] = {
      batchedObservations: 0,
      batchPromptsSaved: 0,
      totalPromptChars: 0,
      truncatedFields: 5,
    };
    expect(stats!.truncatedFields).toBe(5);
  });
});

describe("truncation observability", () => {
  test("returns truncatedFields > 0 when fields exceed limit", () => {
    const bigInput = JSON.stringify({ file_path: "/tmp/test.ts", content: "x".repeat(5000) });
    const bigOutput = JSON.stringify("y".repeat(5000));
    const result = buildObservationPrompt(makeObs(bigInput, bigOutput), 1000);
    expect(result.truncatedFields).toBeGreaterThan(0);
    expect(typeof result.prompt).toBe("string");
    expect(result.prompt).toContain("[... truncated");
  });

  test("returns truncatedFields=0 when fields fit", () => {
    const result = buildObservationPrompt(makeObs('{"file_path":"/tmp/a.ts"}', '"ok"'), 8000);
    expect(result.truncatedFields).toBe(0);
    expect(typeof result.prompt).toBe("string");
  });

  test("batch sums truncatedFields across all observations", () => {
    const bigInput = JSON.stringify({ file_path: "/tmp/test.ts", content: "x".repeat(5000) });
    const bigOutput = JSON.stringify("y".repeat(5000));
    const result = buildBatchObservationPrompt(
      [makeObs(bigInput, bigOutput), makeObs(bigInput, bigOutput)],
      1000,
    );
    expect(result.truncatedFields).toBeGreaterThanOrEqual(2);
    expect(typeof result.prompt).toBe("string");
  });
});
