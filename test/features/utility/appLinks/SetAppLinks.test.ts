import { beforeEach, describe, expect, test } from "bun:test";
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

    expect(appLinks.calls).toContain(`set ${PKG} approved all`);
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
