import { readGuardFile } from "./astGuard";
import { describe, expect, test } from "bun:test";

import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const read = (rel: string): string => readGuardFile(path.join(root, rel));

const PROMISE_RULES = ["no-floating-promises", "no-misused-promises"] as const;

describe("type-aware promise rules are enforced", () => {
  test("are error-level in .oxlintrc.json", () => {
    const config = read(".oxlintrc.json");
    for (const rule of PROMISE_RULES) {
      expect(config).toContain(`"typescript/${rule}": "error"`);
    }
  });

  // The fast oxlint stage is not --type-aware, so the ratchet stage is the only
  // place these rules run. Dropping them from RATCHET_CODES leaves them unchecked.
  test("stay in the type-aware ratchet stage's gated codes", () => {
    const script = read("scripts/oxlint-baseline.sh");
    const codes = /^RATCHET_CODES="([^"]*)"/m.exec(script)?.[1] ?? "";
    for (const rule of PROMISE_RULES) {
      expect(codes.split(" ")).toContain(`typescript(${rule})`);
    }
    // The type-aware invocation lives in the host-slot helper; the ratchet script must run it.
    expect(script).toContain("host_heavy_run host_heavy_oxlint_type_aware");
    expect(read("scripts/lib/host-heavy-run.sh")).toContain("oxlint --type-aware");
  });

  test("have a zero baseline", () => {
    const baseline = read("scripts/oxlint-baseline.txt");
    for (const rule of PROMISE_RULES) {
      expect(baseline.split("\n").some((l) => l.endsWith(`\ttypescript(${rule})`))).toBe(false);
    }
  });
});
