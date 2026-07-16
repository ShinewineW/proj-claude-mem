/**
 * Property-based tests for the bypass-concurrency change set (file-to-prod
 * Stage 3, invariants P1–P5 from attn_sink/audit-context-report-bypass-concurrency.md).
 *
 * Deterministic seeded PRNG (mulberry32) — identical inputs on every run, so
 * these never flake under machine load, unlike wall-clock-driven fuzz tests.
 */
import { describe, test, expect } from "bun:test";
import { GlobalSemaphore } from "../../src/services/worker/global-semaphore.js";
import {
  readIntBounded,
  classifyBypassFailure,
} from "../../src/services/worker/BypassLane.js";
import {
  parseSkipPatterns,
  shouldSkipObservation,
} from "../../src/services/worker/http/routes/observation-filter.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("P1: GlobalSemaphore never exceeds a constant limit under random interleavings", () => {
  test("peak concurrency <= limit across randomized workloads (seeded)", async () => {
    const rnd = mulberry32(0xbeef01);
    for (let round = 0; round < 5; round++) {
      const limit = 1 + Math.floor(rnd() * 5); // 1..5
      const workers = 8 + Math.floor(rnd() * 12); // 8..19
      const sem = new GlobalSemaphore(() => limit);
      const ac = new AbortController();
      let peak = 0, cur = 0;
      const work = async (holdMs: number) => {
        await sem.acquire(ac.signal);
        cur++; peak = Math.max(peak, cur);
        await new Promise((r) => setTimeout(r, holdMs));
        cur--; sem.release();
      };
      await Promise.all(
        Array.from({ length: workers }, () => work(1 + Math.floor(rnd() * 8))),
      );
      expect(peak).toBeLessThanOrEqual(limit);
      expect(cur).toBe(0); // all workers released
    }
  });
});

describe("P2: readIntBounded totality and validateSettings-consistency", () => {
  const LO = 60000, HI = 86400000, DEF = 1200000;
  // Mirror of SettingsRoutes.validateSettings intBounds acceptance predicate.
  const uiAccepts = (raw: string): boolean => {
    const n = Number(String(raw).trim());
    return Number.isInteger(n) && n >= LO && n <= HI;
  };

  test("arbitrary strings -> result always in [lo,hi] (def included)", () => {
    const rnd = mulberry32(0xbeef02);
    const alphabet = "0123456789-+.eE junk\t";
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(rnd() * 12);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const out = readIntBounded(s, DEF, LO, HI);
      expect(out).toBeGreaterThanOrEqual(LO);
      expect(out).toBeLessThanOrEqual(HI);
      // Consistency: UI-accepted values pass through verbatim; UI-rejected -> default.
      if (uiAccepts(s)) {
        expect(out).toBe(Number(s.trim()));
      } else {
        expect(out).toBe(DEF);
      }
    }
  });

  test("in-range integers always pass through verbatim", () => {
    const rnd = mulberry32(0xbeef03);
    for (let i = 0; i < 200; i++) {
      const n = LO + Math.floor(rnd() * (HI - LO + 1));
      expect(readIntBounded(String(n), DEF, LO, HI)).toBe(n);
    }
  });
});

describe("P3: classifyBypassFailure is total, deterministic, envelope-priority", () => {
  const CATS = ["quota", "auth", "transient", "client", "ratelimit"];

  test("all statuses 100..599 x envelope hints map into the 5 buckets", () => {
    const envelopes = [
      {},
      { code: "insufficient_quota" },
      { type: "insufficient_quota" },
      { type: "AuthError" },
      { type: "ModelError" },
      { type: "SomethingElse" },
    ];
    for (let status = 100; status <= 599; status++) {
      for (const env of envelopes) {
        const out = classifyBypassFailure(status, env);
        expect(CATS).toContain(out);
        // determinism
        expect(classifyBypassFailure(status, env)).toBe(out);
        // envelope priority is absolute
        if (env.code === "insufficient_quota" || env.type === "insufficient_quota") {
          expect(out).toBe("quota");
        } else if (env.type === "AuthError") {
          expect(out).toBe("auth");
        } else if (env.type === "ModelError") {
          expect(out).toBe("client");
        } else if (status === 429) {
          expect(out).toBe("ratelimit");
        }
      }
    }
  });
});

describe("P4: compound-command guard dominates every pattern set", () => {
  const controlChars = ["&", ";", "|", "<", ">", "`", "$("];
  const patternSets = [
    parseSkipPatterns("Bash:*"),
    parseSkipPatterns("Bash:cd *,Bash:echo *,Bash:cat *.log"),
    parseSkipPatterns("Bash:*,Read:*,Glob:*"),
  ];

  test("any Bash command containing a control operator is NEVER skipped", () => {
    const rnd = mulberry32(0xbeef04);
    const verbs = ["cd /repo", "echo hi", "ls", "pwd", "cat a.log", "sleep 5"];
    const tails = ["pytest -q", "python run.py", "make build", "f.txt"];
    for (let i = 0; i < 300; i++) {
      const verb = verbs[Math.floor(rnd() * verbs.length)];
      const op = controlChars[Math.floor(rnd() * controlChars.length)];
      const tail = tails[Math.floor(rnd() * tails.length)];
      const command = `${verb} ${op} ${tail}`;
      for (const patterns of patternSets) {
        expect(shouldSkipObservation("Bash", { command }, patterns)).toBe(false);
      }
    }
  });

  test("guard applies only to Bash — other tools are unaffected by it", () => {
    const patterns = parseSkipPatterns("Read:*");
    // A Read whose file_path contains '&' is still governed by patterns, not the guard.
    expect(shouldSkipObservation("Read", { file_path: "/a&b.ts" }, patterns)).toBe(true);
  });
});

describe("P5: globToRegex escapes every metacharacter except *", () => {
  test("non-glob patterns match themselves and only themselves (no regex injection)", () => {
    const rnd = mulberry32(0xbeef05);
    const specials = ".+^${}()|[]\\";
    for (let i = 0; i < 200; i++) {
      const len = 1 + Math.floor(rnd() * 8);
      let s = "";
      for (let j = 0; j < len; j++) {
        const pool = rnd() < 0.5 ? specials : "abcXYZ019/_-";
        s += pool[Math.floor(rnd() * pool.length)];
      }
      if (s.includes(",") || s.includes(":") || s.includes("*")) continue; // parser separators / glob char
      const patterns = parseSkipPatterns(`Read:${s}`);
      expect(patterns.length).toBe(1);
      // literal self-match
      expect(patterns[0].regex.test(s)).toBe(true);
      // '.' must NOT act as a wildcard: a.b should not match aXb
      if (s.includes(".")) {
        const mutated = s.replace(".", "Q");
        expect(patterns[0].regex.test(mutated)).toBe(false);
      }
    }
  });

  test("* crosses path separators (documented pre-existing behavior)", () => {
    const patterns = parseSkipPatterns("Read:*SKILL.md");
    expect(patterns[0].regex.test("/deep/nested/dir/SKILL.md")).toBe(true);
  });
});
