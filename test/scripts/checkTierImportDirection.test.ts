import { describe, expect, test } from "bun:test";
import { TIER_RULES, isViolation } from "../../scripts/check-tier-import-direction";

const rule = (tier: string) => TIER_RULES.find((r) => r.tier === tier)!;

describe("tier import direction rules (#11789)", () => {
  test("models is a leaf: only models, constants and config", () => {
    const models = rule("models");
    expect(isViolation(models, "src/models/ActionableError")).toBe(false);
    expect(isViolation(models, "src/constants/x")).toBe(false);
    expect(isViolation(models, "src/utils/describeUnknownError")).toBe(true);
    expect(isViolation(models, "src/features/observe/Foo")).toBe(true);
    expect(isViolation(models, "test/helpers/x")).toBe(true);
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
});
