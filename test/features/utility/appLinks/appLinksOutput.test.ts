import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  appLinkRestoreTarget,
  appLinksOutputReportsUnsupported,
  parseAppLinksOutput,
  toAppLinkDomainStates,
} from "../../../../src/features/utility/appLinks/appLinksOutput";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../fixtures/android-app-links/${name}`, import.meta.url), "utf8");

const PKG = "com.example.shop";

describe("parseAppLinksOutput (#14110)", () => {
  test("API 31: verification states and a Disabled-only user section", () => {
    const snapshot = parseAppLinksOutput(fixture("get-app-links-api31-user0.txt"), PKG);
    expect(snapshot).not.toBeNull();
    expect([...snapshot!.verification]).toEqual([
      ["shop.example.com", "verified"],
      ["www.shop.example.com", "none"],
    ]);
    expect(snapshot!.user).toEqual({
      userId: 0,
      linkHandlingAllowed: true,
      domains: ["shop.example.com", "www.shop.example.com", "promo.example.net"],
      enabled: [],
    });
    expect(toAppLinkDomainStates(snapshot!)).toEqual([
      {
        domain: "shop.example.com",
        state: "verified",
        autoVerify: true,
        userSelected: false,
        approvedForLinks: true,
      },
      {
        domain: "www.shop.example.com",
        state: "none",
        autoVerify: true,
        userSelected: false,
        approvedForLinks: false,
      },
      {
        domain: "promo.example.net",
        autoVerify: false,
        userSelected: false,
        approvedForLinks: false,
      },
    ]);
  });

  test("API 34: status header, every state kind, Enabled list, and a following package", () => {
    const snapshot = parseAppLinksOutput(fixture("get-app-links-api34-user0-mixed.txt"), PKG);
    expect(Object.fromEntries(snapshot!.verification)).toEqual({
      "shop.example.com": "approved",
      "www.shop.example.com": "legacy_failure",
      "checkout.example.com": "1026",
      "blocked.example.com": "denied",
    });
    expect(snapshot!.user?.enabled).toEqual(["promo.example.net"]);
    const byDomain = Object.fromEntries(
      toAppLinkDomainStates(snapshot!).map((d) => [d.domain, d.approvedForLinks]),
    );
    expect(byDomain).toEqual({
      "shop.example.com": true,
      "www.shop.example.com": false,
      "checkout.example.com": false,
      "blocked.example.com": false,
      "promo.example.net": true,
    });
  });

  test("the block stops at the next package, so a prefix-named package is read separately", () => {
    const snapshot = parseAppLinksOutput(
      fixture("get-app-links-api34-user0-mixed.txt"),
      "com.example.shop.debug",
    );
    expect([...snapshot!.verification]).toEqual([["shop.example.com", "none"]]);
    expect(snapshot!.user).toBeUndefined();
  });

  test("API 35: tab indentation, a non-zero user, and link handling disallowed", () => {
    const snapshot = parseAppLinksOutput(
      fixture("get-app-links-api35-user10-handling-disabled.txt"),
      PKG,
    );
    expect(snapshot!.user?.userId).toBe(10);
    expect(snapshot!.user?.linkHandlingAllowed).toBe(false);
    expect(snapshot!.verification.get("shop.example.com")).toBe("system_configured");
    // Verified-equivalent, but disallowed link handling keeps the app from opening it.
    expect(toAppLinkDomainStates(snapshot!)[0]?.approvedForLinks).toBe(false);
  });

  test.each([
    ["get-app-links-api37-system-configured.txt", "system_configured"],
    ["get-app-links-api37-after-restore-verified.txt", "verified"],
  ])("API 37 real capture: %s", (name, state) => {
    const snapshot = parseAppLinksOutput(fixture(name), "com.google.android.calendar");
    expect(snapshot).not.toBeNull();
    expect([...snapshot!.verification]).toEqual([
      ["www.google.com", state],
      ["calendar.google.com", state],
      ["client-side-encryption.google.com", state],
      ["krahsc.google.com", state],
    ]);
    expect(snapshot!.user).toBeUndefined();
    expect(toAppLinkDomainStates(snapshot!).every((domain) => domain.approvedForLinks)).toBe(true);
  });

  test("CRLF line endings parse the same", () => {
    const crlf = fixture("get-app-links-api31-user0.txt").replace(/\n/g, "\r\n");
    expect(parseAppLinksOutput(crlf, PKG)).toEqual(
      parseAppLinksOutput(fixture("get-app-links-api31-user0.txt"), PKG),
    );
  });

  test("a read without --user has verification states only", () => {
    const snapshot = parseAppLinksOutput(fixture("get-app-links-no-user.txt"), PKG);
    expect(snapshot!.user).toBeUndefined();
    expect(toAppLinkDomainStates(snapshot!).map((d) => d.approvedForLinks)).toEqual([true, true]);
  });

  test("no block for the package and pre-API-31 pm output", () => {
    expect(parseAppLinksOutput("", PKG)).toBeNull();
    expect(parseAppLinksOutput(fixture("get-app-links-api31-user0.txt"), "com.other")).toBeNull();
    expect(
      appLinksOutputReportsUnsupported(fixture("get-app-links-api30-unknown-command.txt")),
    ).toBe(true);
    expect(appLinksOutputReportsUnsupported(fixture("get-app-links-api31-user0.txt"))).toBe(false);
  });
});

describe("appLinkRestoreTarget", () => {
  test("settable states restore exactly; others to the closest settable state", () => {
    expect(appLinkRestoreTarget("none")).toEqual({ state: "none", exact: true });
    expect(appLinkRestoreTarget("verified")).toEqual({ state: "verified", exact: true });
    expect(appLinkRestoreTarget("approved")).toEqual({ state: "approved", exact: true });
    expect(appLinkRestoreTarget("denied")).toEqual({ state: "denied", exact: true });
    for (const state of ["migrated", "restored", "system_configured", "pre_verified"]) {
      expect(appLinkRestoreTarget(state)).toEqual({ state: "verified", exact: false });
    }
    for (const state of ["legacy_failure", "1026", "toString"]) {
      expect(appLinkRestoreTarget(state)).toEqual({ state: "none", exact: false });
    }
  });
});
