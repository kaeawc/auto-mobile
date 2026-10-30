import { describe, expect, test } from "bun:test";
import { TIER_RULES, isViolation } from "../../scripts/check-tier-import-direction";

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

  test("the daemon client side may not import the session, pool or socket-server runtime", () => {
    for (const tier of ["daemon/proxy", "daemon/mcpProxy", "daemon/client"]) {
      const client = rule(tier);
      expect(isViolation(client, "src/daemon/sessionManager")).toBe(true);
      expect(isViolation(client, "src/daemon/sessionManager/sessionTypes")).toBe(true);
      expect(isViolation(client, "src/daemon/devicePoolParts/deviceAllocation")).toBe(true);
      expect(isViolation(client, "src\\daemon\\socketServer")).toBe(true);
      expect(isViolation(client, "src/daemon/sessionManager/releaseTypes")).toBe(false);
      expect(isViolation(client, "src/daemon/sessionManager/sessionConstants")).toBe(false);
      expect(isViolation(client, "src/daemon/client/client")).toBe(false);
      expect(isViolation(client, "src/server/toolRegistry")).toBe(false);
    }
  });

  test("the daemon wire package imports only itself from the daemon (#11790)", () => {
    const wire = rule("daemon/wire");
    expect(isViolation(wire, "src/daemon/wire/constants")).toBe(false);
    expect(isViolation(wire, "src/daemon/sessionManager")).toBe(true);
    expect(isViolation(wire, "src/daemon/types")).toBe(true);
    expect(isViolation(wire, "src\\daemon\\wire\\LineFramer")).toBe(false);
    expect(isViolation(wire, "src/utils/logger")).toBe(false);
  });
});
