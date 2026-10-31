import { describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../../src/models";
import {
  AppLinksRestoreRegistry,
  planAppLinksRestore,
  restoreAppLinksEntries,
} from "../../../../src/features/utility/appLinks/AppLinkRestore";
import { logger } from "../../../../src/utils/logger";
import { FakeAppLinksDevice } from "../../../fakes/FakeAppLinksDevice";

const device: BootedDevice = { name: "emulator", platform: "android", deviceId: "emulator-5554" };
const other: BootedDevice = { name: "emulator", platform: "android", deviceId: "emulator-5556" };

const snapshot = (verification: Record<string, string>, enabled: string[] = []) => ({
  verification: new Map(Object.entries(verification)),
  user: { userId: 0, domains: ["a.example.com", "b.example.com"], enabled },
});

describe("AppLinksRestoreRegistry (#14110)", () => {
  test("records each part once and hands the entry to a writing session", () => {
    const registry = new AppLinksRestoreRegistry();
    registry.record(device, "com.a", snapshot({ "a.example.com": "none" }), {
      scope: { verification: true },
    });
    registry.record(device, "com.a", snapshot({ "a.example.com": "approved" }, ["b.example.com"]), {
      scope: { verification: true, userId: 0 },
      owner: "s1",
    });
    const entry = registry.get(device.deviceId, "com.a");
    expect(entry?.owner).toBe("s1");
    expect(entry?.verification?.get("a.example.com")).toBe("none");
    expect(entry?.selections.get(0)).toEqual(["b.example.com"]);
  });

  test("later writes add domains without overwriting an earlier original", () => {
    const registry = new AppLinksRestoreRegistry();
    registry.record(device, "com.a", snapshot({ "b.example.com": "none" }), {
      scope: { verification: true },
    });
    const entry = registry.record(
      device,
      "com.a",
      snapshot({ "a.example.com": "system_configured", "b.example.com": "approved" }),
      { scope: { verification: true } },
    );
    expect(Object.fromEntries(entry.verification ?? [])).toEqual({
      "a.example.com": "system_configured",
      "b.example.com": "none",
    });
  });

  test("record never replaces the first session owner", () => {
    const registry = new AppLinksRestoreRegistry();
    registry.record(device, "com.a", snapshot({}), { scope: { verification: false }, owner: "s1" });
    const entry = registry.record(device, "com.a", snapshot({}), {
      scope: { verification: false },
      owner: "s2",
    });
    expect(entry.owner).toBe("s1");
    expect(registry.takeOwnedBy(device.deviceId, "s2")).toEqual([]);
    expect(registry.takeOwnedBy(device.deviceId, "s1")).toEqual([entry]);
  });

  test("takeOwnedBy returns only the session's entries on that device", () => {
    const registry = new AppLinksRestoreRegistry();
    const scope = { verification: true };
    registry.record(device, "com.a", snapshot({}), { scope, owner: "s1" });
    registry.record(device, "com.b", snapshot({}), { scope, owner: "s1" });
    registry.record(device, "com.c", snapshot({}), { scope, owner: "s2" });
    registry.record(other, "com.a", snapshot({}), { scope, owner: "s1" });
    registry.record(device, "com.d", snapshot({}), { scope });

    expect(registry.takeOwnedBy(device.deviceId, "s1").map((e) => e.packageName)).toEqual([
      "com.a",
      "com.b",
    ]);
    expect(registry.takeOwnedBy(device.deviceId, "s1")).toEqual([]);
    expect(registry.get(device.deviceId, "com.c")).toBeDefined();
    expect(registry.get(device.deviceId, "com.d")).toBeDefined();

    registry.retireDevice(device.deviceId);
    expect(registry.get(device.deviceId, "com.c")).toBeUndefined();
    expect(registry.get(other.deviceId, "com.a")).toBeDefined();
  });
});

describe("planAppLinksRestore", () => {
  test("writes only differing domains, grouped by target state, and flags inexact ones", () => {
    const plan = planAppLinksRestore(
      {
        verification: new Map([
          ["a.example.com", "verified"],
          ["b.example.com", "system_configured"],
          ["c.example.com", "1026"],
          ["d.example.com", "none"],
          ["gone.example.com", "verified"],
        ]),
        selections: new Map(),
      },
      {
        verification: new Map([
          ["a.example.com", "approved"],
          ["b.example.com", "approved"],
          ["c.example.com", "none"],
          ["d.example.com", "none"],
        ]),
        users: new Map(),
      },
    );
    expect([...plan.verification]).toEqual([["verified", ["a.example.com", "b.example.com"]]]);
    expect(plan.inexact).toEqual([
      { domain: "b.example.com", original: "system_configured", restoredAs: "verified" },
    ]);
  });

  test("untouched system-configured domains need no restore or inexact warning", async () => {
    const appLinks = new FakeAppLinksDevice().install("com.a", {
      verification: { "a.example.com": "system_configured", "b.example.com": "approved" },
    });
    const current = await appLinks.read("com.a");
    if (!current.found) {
      throw new Error(current.reason);
    }
    const plan = planAppLinksRestore(
      {
        verification: new Map([
          ["a.example.com", "system_configured"],
          ["b.example.com", "none"],
        ]),
        selections: new Map(),
      },
      { verification: current.snapshot.verification, users: new Map() },
    );
    expect([...plan.verification]).toEqual([["none", ["b.example.com"]]]);
    expect(plan.inexact).toEqual([]);
  });

  test("user selections diff both ways and skip domains no longer declared", () => {
    const plan = planAppLinksRestore(
      { selections: new Map([[0, ["a.example.com", "removed.example.com"]]]) },
      { verification: new Map(), users: new Map([[0, snapshot({}, ["b.example.com"])]]) },
    );
    expect(plan.selections).toEqual([
      { userId: 0, enable: ["a.example.com"], disable: ["b.example.com"] },
    ]);
  });
});

describe("restoreAppLinksEntries", () => {
  test("session release restores the first originals from a merged entry", async () => {
    const registry = new AppLinksRestoreRegistry();
    const appLinks = new FakeAppLinksDevice().install("com.a", {
      verification: { "a.example.com": "verified", "b.example.com": "approved" },
      users: { 0: { enabled: ["a.example.com"] } },
    });
    const original = await appLinks.read("com.a", 0);
    registry.record(device, "com.a", snapshot({ "a.example.com": "verified" }), {
      scope: { verification: true },
    });
    await appLinks.setVerificationState("com.a", "approved", ["a.example.com"]);
    const beforeReset = await appLinks.read("com.a", 0);
    if (!beforeReset.found) {
      throw new Error(beforeReset.reason);
    }
    registry.record(device, "com.a", beforeReset.snapshot, {
      scope: { verification: true, userId: 0 },
      owner: "s1",
    });
    await appLinks.setVerificationState("com.a", "none", "all");
    await appLinks.setUserSelection("com.a", 0, false, { domains: "all" });
    const entries = registry.takeOwnedBy(device.deviceId, "s1");
    expect(entries).toHaveLength(1);
    expect(registry.get(device.deviceId, "com.a")).toBeUndefined();
    expect(await restoreAppLinksEntries(entries, () => appLinks)).toEqual([]);
    expect(await appLinks.read("com.a", 0)).toEqual(original);
  });

  test("restores each entry and reports the ones that fail", async () => {
    const appLinks = new FakeAppLinksDevice()
      .install("com.a", { verification: { "a.example.com": "approved" } })
      .install("com.b", { verification: { "b.example.com": "approved" } });
    appLinks.failNext("read", new Error("adb: device offline"));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const failed = await restoreAppLinksEntries(
        [
          {
            device,
            packageName: "com.b",
            verification: new Map([["b.example.com", "none"]]),
            selections: new Map(),
          },
          {
            device,
            packageName: "com.a",
            verification: new Map([["a.example.com", "migrated"]]),
            selections: new Map(),
          },
        ],
        () => appLinks,
      );
      expect(failed).toEqual(["com.b"]);
      expect(appLinks.state("com.a", "a.example.com")).toBe("verified");
      expect(appLinks.state("com.b", "b.example.com")).toBe("approved");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
