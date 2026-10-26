import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toJSONSchema } from "zod/v4";
import { setAppLinksResultSchema } from "../../../../src/server/deepLinkToolOutputSchemas";
import type { BootedDevice } from "../../../../src/models";
import { AppLinksRestoreRegistry } from "../../../../src/features/utility/appLinks/AppLinkRestore";
import { setAppLinks } from "../../../../src/features/utility/appLinks/SetAppLinks";
import { FakeAppLinksDevice, fakeAppLinksTarget } from "../../../fakes/FakeAppLinksDevice";

const PKG = "com.example.shop";
const device: BootedDevice = { name: "emulator", platform: "android", deviceId: "emulator-5554" };

describe("setAppLinks (#14110)", () => {
  let appLinks: FakeAppLinksDevice;
  let registry: AppLinksRestoreRegistry;

  beforeEach(() => {
    appLinks = new FakeAppLinksDevice().install(PKG, {
      verification: { "shop.example.com": "legacy_failure", "www.shop.example.com": "none" },
      otherDomains: ["promo.example.net"],
    });
    registry = new AppLinksRestoreRegistry();
  });

  const deps = (owner?: string, apiLevel: number | null = 34) => ({
    target: fakeAppLinksTarget(appLinks, { apiLevel }),
    registry,
    owner,
  });

  test("approve force-approves every autoVerify domain and returns a restore receipt", async () => {
    const result = await setAppLinks(device, { appId: PKG, action: "approve" }, deps("s1"));

    expect(appLinks.calls).toContain(`set ${PKG} approved shop.example.com,www.shop.example.com`);
    expect(result.userId).toBe(0);
    expect(result.changed).toEqual([
      {
        domain: "shop.example.com",
        before: { state: "legacy_failure", userSelected: false },
        after: { state: "approved", userSelected: false },
      },
      {
        domain: "www.shop.example.com",
        before: { state: "none", userSelected: false },
        after: { state: "approved", userSelected: false },
      },
    ]);
    expect(result.unapplied).toBeUndefined();
    expect(result.appLinks.filter((d) => d.approvedForLinks).map((d) => d.domain)).toEqual([
      "shop.example.com",
      "www.shop.example.com",
    ]);
    expect(result.restore).toEqual({
      onSessionRelease: true,
      verification: [
        {
          domain: "shop.example.com",
          original: "legacy_failure",
          restoreAs: "none",
          exact: false,
        },
        { domain: "www.shop.example.com", original: "none", restoreAs: "none", exact: true },
      ],
    });
  });

  test.each([{ domains: undefined }, { domains: ["a.example.com", "b.example.com"] }])(
    "approve leaves system-configured domains untouched for domains %j",
    async ({ domains }) => {
      appLinks.install(PKG, {
        verification: {
          "a.example.com": "system_configured",
          "b.example.com": "system_configured",
        },
      });
      const before = await appLinks.read(PKG, 0);
      const result = await setAppLinks(device, { appId: PKG, action: "approve", domains }, deps());
      expect(appLinks.calls.filter((call) => call.startsWith("set "))).toEqual([]);
      expect(result.skipped).toEqual(
        ["a.example.com", "b.example.com"].map((domain) => ({
          domain,
          state: "system_configured",
          reason:
            "already system_configured; the shell cannot restore that state, so it was left untouched",
        })),
      );
      expect(result.unapplied).toBeUndefined();
      expect(result.changed).toEqual([]);
      expect(result.restore).toBeUndefined();
      expect(registry.get(device.deviceId, PKG)).toBeUndefined();
      expect(await appLinks.read(PKG, 0)).toEqual(before);
    },
  );

  test.each(
    ["system_configured", "pre_verified", "migrated", "restored"].flatMap((state) => [
      { state, domains: undefined },
      { state, domains: ["a.example.com", "b.example.com"] },
    ]),
  )("mixed approve preserves the exact original: %j", async ({ state, domains }) => {
    appLinks.install(PKG, { verification: { "a.example.com": state, "b.example.com": "none" } });
    const before = await appLinks.read(PKG, 0);
    const result = await setAppLinks(device, { appId: PKG, action: "approve", domains }, deps());
    expect(appLinks.calls.filter((call) => call.startsWith("set "))).toEqual([
      `set ${PKG} approved b.example.com`,
    ]);
    expect(result.skipped?.map((entry) => entry.domain)).toEqual(["a.example.com"]);
    expect(result.changed.map((entry) => entry.domain)).toEqual(["b.example.com"]);
    expect(result.unapplied).toBeUndefined();
    expect(result.restore?.verification).toEqual([
      { domain: "b.example.com", original: "none", restoreAs: "none", exact: true },
    ]);
    const restored = await setAppLinks(device, { appId: PKG, action: "restore" }, deps());
    expect(await appLinks.read(PKG, 0)).toEqual(before);
    expect(restored.note).toBeUndefined();
    expect(restored.restore).toBeUndefined();
  });

  test("subset approve then reset and restore preserve the exact first originals", async () => {
    appLinks.install(PKG, {
      verification: {
        "a.example.com": "verified",
        "b.example.com": "approved",
        "c.example.com": "system_configured",
      },
    });
    const original = await appLinks.read(PKG, 0);
    await setAppLinks(
      device,
      { appId: PKG, action: "approve", domains: ["a.example.com"] },
      deps(),
    );
    const reset = await setAppLinks(
      device,
      { appId: PKG, action: "reset", domains: ["b.example.com"] },
      deps(),
    );
    expect(reset.restore?.verification?.find((entry) => entry.domain === "c.example.com")).toEqual({
      domain: "c.example.com",
      original: "system_configured",
      restoreAs: "verified",
      exact: false,
    });
    expect(reset.note).toBeUndefined();
    const restored = await setAppLinks(device, { appId: PKG, action: "restore" }, deps());
    expect(await appLinks.read(PKG, 0)).toEqual(original);
    expect(restored.note).toBeUndefined();
    expect(restored.restore).toBeUndefined();
  });

  test.each([undefined, "first-session"])(
    "skip-all approve adopts only a sessionless entry (owner %j)",
    async (owner) => {
      appLinks.install(PKG, {
        verification: { "a.example.com": "system_configured" },
        otherDomains: ["promo.example.net"],
      });
      await setAppLinks(
        device,
        { appId: PKG, action: "userSelection", domains: ["promo.example.net"], enabled: true },
        deps(owner),
      );
      const entry = registry.get(device.deviceId, PKG);
      if (!entry) {
        throw new Error("Expected the user-selection change to be recorded");
      }
      const result = await setAppLinks(device, { appId: PKG, action: "approve" }, deps("s2"));
      expect(result.skipped?.map((skip) => skip.domain)).toEqual(["a.example.com"]);
      expect(registry.get(device.deviceId, PKG)).toBe(entry);
      expect(entry?.owner).toBe(owner ?? "s2");
      expect(entry?.verification).toBeUndefined();
      expect(result.restore?.onSessionRelease).toBe(true);
      expect(registry.takeOwnedBy(device.deviceId, "s2")).toEqual(owner ? [] : [entry]);
    },
  );

  test("recorded but unchanged inexact original produces no pending note", async () => {
    appLinks.install(PKG, {
      verification: { "a.example.com": "system_configured", "b.example.com": "none" },
    });
    const original = await appLinks.read(PKG, 0);
    if (!original.found) {
      throw new Error(original.reason);
    }
    registry.record(device, PKG, original.snapshot, { verification: true }, undefined);
    const result = await setAppLinks(device, { appId: PKG, action: "approve" }, deps());
    expect(result.restore?.verification?.some((entry) => !entry.exact)).toBe(true);
    expect(result.note).toBeUndefined();
    expect(appLinks.state(PKG, "a.example.com")).toBe("system_configured");
    expect(appLinks.state(PKG, "b.example.com")).toBe("approved");
  });

  test("reset still writes system-configured domains and restore explains the drift", async () => {
    appLinks.install(PKG, { verification: { "a.example.com": "system_configured" } });
    const reset = await setAppLinks(device, { appId: PKG, action: "reset" }, deps());
    expect(appLinks.calls).toContain(`set ${PKG} none all`);
    expect(reset.restore?.verification).toEqual([
      {
        domain: "a.example.com",
        original: "system_configured",
        restoreAs: "verified",
        exact: false,
      },
    ]);
    expect(reset.note).toContain("system_configured");
    const restored = await setAppLinks(device, { appId: PKG, action: "restore" }, deps());
    expect(appLinks.state(PKG, "a.example.com")).toBe("verified");
    expect(restored.note).toContain("Restored a.example.com as verified");
    expect(restored.note).toContain("the shell cannot set its original state system_configured");
    expect(restored.restore).toBeUndefined();
  });

  test("the published output schema declares skipped domains and matches the live schema", () => {
    const definitions: { name: string; outputSchema: unknown }[] = JSON.parse(
      readFileSync(new URL("../../../../schemas/tool-definitions.json", import.meta.url), "utf8"),
    );
    expect(definitions.find((tool) => tool.name === "setAppLinks")?.outputSchema).toEqual(
      toJSONSchema(setAppLinksResultSchema, { reused: "ref" }),
    );
    expect(
      setAppLinksResultSchema.shape.skipped.safeParse([
        { domain: "a.example.com", state: "system_configured", reason: 42 },
      ]).success,
    ).toBe(false);
  });

  test("approve of a non-autoVerify domain is refused before any write", async () => {
    await expect(
      setAppLinks(
        device,
        { appId: PKG, action: "approve", domains: ["promo.example.net"] },
        deps(),
      ),
    ).rejects.toThrow(/does not declare promo\.example\.net for approve.*userSelection/);
    expect(appLinks.calls.some((call) => call.startsWith("set "))).toBe(false);
    expect(registry.get(device.deviceId, PKG)).toBeUndefined();
  });

  test("userSelection enables a declared domain for the named user", async () => {
    const result = await setAppLinks(
      device,
      {
        appId: PKG,
        userId: 0,
        action: "userSelection",
        domains: ["promo.example.net"],
        enabled: true,
      },
      deps(),
    );
    expect(appLinks.calls).toContain(`select ${PKG} 0 true promo.example.net`);
    expect(result.changed.map((c) => c.domain)).toEqual(["promo.example.net"]);
    expect(result.restore).toEqual({
      onSessionRelease: false,
      userSelections: [{ userId: 0, enabled: [] }],
    });
  });

  test("a write pm silently skipped is reported as unapplied", async () => {
    // pm exits 0 even when it applies nothing; the read-back is the only evidence.
    const result = await setAppLinks(
      device,
      { appId: PKG, action: "reset", domains: ["shop.example.com"] },
      { ...deps(), target: { ...fakeAppLinksTarget(appLinks), appLinks: stuckDevice(appLinks) } },
    );
    expect(result.unapplied).toEqual(["shop.example.com"]);
  });

  test("restore writes back the recorded original and forgets it", async () => {
    await setAppLinks(device, { appId: PKG, action: "approve" }, deps());
    const result = await setAppLinks(device, { appId: PKG, action: "restore" }, deps());

    // legacy_failure cannot be set from the shell: it comes back as none.
    expect(appLinks.state(PKG, "shop.example.com")).toBe("none");
    expect(appLinks.state(PKG, "www.shop.example.com")).toBe("none");
    expect(result.restore).toBeUndefined();
    expect(registry.get(device.deviceId, PKG)).toBeUndefined();
  });

  test("a failed restore keeps the record for a retry", async () => {
    await setAppLinks(device, { appId: PKG, action: "approve" }, deps());
    appLinks.failNext("setVerificationState", new Error("adb: device offline"));
    await expect(setAppLinks(device, { appId: PKG, action: "restore" }, deps())).rejects.toThrow(
      "device offline",
    );
    expect(registry.get(device.deviceId, PKG)).toBeDefined();

    await setAppLinks(device, { appId: PKG, action: "restore" }, deps());
    expect(appLinks.state(PKG, "www.shop.example.com")).toBe("none");
    expect(registry.get(device.deviceId, PKG)).toBeUndefined();
  });

  test("restore with nothing recorded changes nothing and says so", async () => {
    const result = await setAppLinks(device, { appId: PKG, action: "restore" }, deps());
    expect(result.changed).toEqual([]);
    expect(result.note).toContain("Nothing recorded to restore");
  });

  test("the first recording wins: a later change keeps the original state", async () => {
    await setAppLinks(device, { appId: PKG, action: "approve" }, deps());
    const result = await setAppLinks(
      device,
      { appId: PKG, action: "reset", domains: ["www.shop.example.com"] },
      deps("s1"),
    );
    expect(result.restore?.verification?.[0]?.original).toBe("legacy_failure");
    expect(result.restore?.onSessionRelease).toBe(true);
  });

  test("a state a restore could not improve on leaves nothing recorded", async () => {
    await setAppLinks(device, { appId: PKG, action: "approve" }, deps());
    // reset returns both domains to none, the closest settable state to legacy_failure.
    const result = await setAppLinks(device, { appId: PKG, action: "reset" }, deps());
    expect(result.restore).toBeUndefined();
  });

  test("returning to the original state clears the record", async () => {
    await setAppLinks(
      device,
      { appId: PKG, action: "userSelection", domains: ["promo.example.net"], enabled: true },
      deps(),
    );
    const result = await setAppLinks(
      device,
      { appId: PKG, action: "userSelection", domains: ["promo.example.net"], enabled: false },
      deps(),
    );
    expect(result.restore).toBeUndefined();
    expect(registry.get(device.deviceId, PKG)).toBeUndefined();
  });

  test("reverify reports the asynchronous verifier", async () => {
    appLinks.reverifyOutcome = { "shop.example.com": "verified" };
    const result = await setAppLinks(device, { appId: PKG, action: "reverify" }, deps());
    expect(appLinks.calls).toContain(`reverify ${PKG}`);
    expect(result.note).toContain("asynchronously");
    expect(result.changed.map((c) => c.after.state)).toEqual(["verified"]);
  });

  test("argument combinations are checked before the device is touched", async () => {
    const cases = [
      { appId: PKG, action: "reverify" as const, domains: ["shop.example.com"] },
      { appId: PKG, action: "userSelection" as const },
      { appId: PKG, action: "approve" as const, enabled: true },
      { appId: PKG, action: "approve" as const, domains: [] },
    ];
    for (const request of cases) {
      await expect(setAppLinks(device, request, deps())).rejects.toThrow(/setAppLinks/);
    }
    expect(appLinks.calls).toEqual([]);
  });

  test("pre-Android 12 devices are refused", async () => {
    await expect(
      setAppLinks(device, { appId: PKG, action: "approve" }, deps(undefined, 30)),
    ).rejects.toThrow(/Android 12 \(API 31\).*API 30/);
  });

  test("a package without App Links state is refused with the read's reason", async () => {
    await expect(
      setAppLinks(device, { appId: "com.missing", action: "approve" }, deps()),
    ).rejects.toThrow(/com\.missing is not installed/);
  });

  test("link handling turned off is called out", async () => {
    appLinks.install(PKG, {
      verification: { "shop.example.com": "none" },
      users: { 0: { linkHandlingAllowed: false } },
    });
    const result = await setAppLinks(device, { appId: PKG, action: "approve" }, deps());
    expect(result.appLinkHandlingAllowed).toBe(false);
    expect(result.note).toContain("Open supported links");
    expect(result.appLinks[0]?.approvedForLinks).toBe(false);
  });
});

/** A device whose verification writes never take effect, as pm does for undeclared domains. */
function stuckDevice(inner: FakeAppLinksDevice): FakeAppLinksDevice {
  const stuck = Object.create(inner) as FakeAppLinksDevice;
  stuck.setVerificationState = async () => {};
  return stuck;
}
