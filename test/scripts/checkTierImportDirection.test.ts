import { describe, expect, test } from "bun:test";
import {
  TIER_RULES,
  isViolation,
  checkTierImports,
} from "../../scripts/check-tier-import-direction";

const rule = (tier: string) => TIER_RULES.find((r) => r.tier === tier)!;

describe("tier import direction rules (#11789)", () => {
  test("models is owned by modelsLeaf.test.ts, not this gate", () => {
    expect(TIER_RULES.map((r) => r.tier)).not.toContain("models");
  });

  test("db may use utils and models but not daemon, server or features", () => {
    const db = rule("db");
    expect(isViolation(db, "src/utils/io")).toBe(false);
    expect(isViolation(db, "src/daemon/releaseReasons")).toBe(true);
    expect(isViolation(db, "src/features/video")).toBe(true);
  });

  test("devices and ctrlProxy may use each other but not upper tiers", () => {
    expect(isViolation(rule("devices"), "src/ctrlProxy/CtrlProxyManager")).toBe(false);
    expect(isViolation(rule("ctrlProxy"), "src/devices/DeviceLockStore")).toBe(false);
    expect(isViolation(rule("devices"), "src/server/ToolExecutionContext")).toBe(true);
  });

  test("features is gated only on importing server, and Windows paths normalize", () => {
    const features = rule("features");
    expect(isViolation(features, "src/daemon/daemonState")).toBe(false);
    expect(isViolation(features, "src\\server\\toolRegistry")).toBe(true);
  });

  test("daemon is gated only on importing server (#11790)", () => {
    const daemon = rule("daemon");
    expect(isViolation(daemon, "src/db/database")).toBe(false);
    expect(isViolation(daemon, "src/features/video")).toBe(false);
    expect(isViolation(daemon, "src/server/appearanceManager")).toBe(true);
  });

  test("a daemon -> server edge fails outright without a baseline", () => {
    const errors: string[] = [];
    const edge = "src/daemon/fixture.ts -> src/server";
    expect(
      checkTierImports(rule("daemon"), [edge], {
        error: (message: string) => errors.push(message),
        log: () => {},
      }),
    ).toBe(false);
    expect(errors).toEqual(["error: daemon import direction violations:", edge]);
  });
});
