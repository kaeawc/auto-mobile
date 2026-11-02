import { describe, expect, test } from "bun:test";
import {
  NAVIGATION_FAMILIES,
  judgeNavigation,
} from "../../../scripts/ios/sdk-contract/navigationSlice";
import {
  SDK_CONTRACT_MANIFEST_SCHEMA_VERSION,
  parseSdkContractManifest,
  type SdkContractManifest,
} from "../../../scripts/ios/sdk-contract/manifest";

// Synthetic judge inputs, not device captures. The judge is pure and needs no timer or I/O fake.
function input(multiScene = false): SdkContractManifest {
  const events = [
    ["uikit_navigation", "UIViewController"],
    ["swiftui_navigation", "contract-swiftui"],
    ["deep_link", "contract-deeplink"],
    ["custom", "contract-custom"],
    ...(multiScene ? [["custom", "contract-second-scene"]] : []),
  ].map(([source, destination], index) => ({
    source: source!,
    destination: destination!,
    sequenceNumber: index + 7,
    sceneIdentifier: index === 4 ? "second" : "first",
    transitionCompleted: true,
  }));
  return {
    schemaVersion: SDK_CONTRACT_MANIFEST_SCHEMA_VERSION,
    scenario: "navigation",
    runId: "unit",
    status: "complete",
    network: [],
    faults: [],
    undecodableBatches: 0,
    capabilities: {
      beforeRegistration: NAVIGATION_FAMILIES.map((id) => ({
        id,
        state: "DISABLED",
        reason: "HOST_OPT_IN",
        faultEnforcement: "NONE",
        faultActions: [],
      })),
      afterRegistration: NAVIGATION_FAMILIES.map((id) => ({
        id,
        state: "SUPPORTED",
        faultEnforcement: "NONE",
        faultActions: [],
      })),
    },
    navigation: {
      deviceClass: multiScene ? "ipad" : "iphone",
      multiScene: multiScene ? "complete" : "not-applicable",
      sceneIdentifiers: multiScene ? ["first", "second"] : ["first"],
      events,
    },
    events: [
      ...events.map((event) => envelope("navigation", event)),
      ...["navigation_committed", "navigation_finished"].map((name) =>
        envelope("webview", { name, webViewId: "contract-navigation" }),
      ),
    ],
  };
}
function envelope(eventType: string, payload: object) {
  return { eventType, payload: Buffer.from(JSON.stringify(payload)).toString("base64") };
}

describe("navigation contract judge", () => {
  for (const multiScene of [false, true]) {
    test(`accepts ordered synthetic input with multiScene=${multiScene}`, () => {
      const manifest = input(multiScene);
      expect(parseSdkContractManifest(JSON.stringify(manifest)).success).toBe(true);
      expect(judgeNavigation(manifest)).toEqual([]);
    });
  }
  test("requires fixture evidence", () => {
    const manifest = input();
    delete manifest.navigation;
    expect(judgeNavigation(manifest)[0]?.boundary).toBe("fixture-host");
  });
  for (const change of ["gap", "duplicate", "descending"] as const) {
    test(`rejects ${change} SDK sequence numbers`, () => {
      const manifest = input();
      const event = manifest.navigation!.events[1]!;
      event.sequenceNumber = change === "gap" ? 10 : change === "duplicate" ? 7 : 6;
      manifest.events[1] = envelope("navigation", event);
      expect(judgeNavigation(manifest).some((finding) => finding.caseName === "sequence")).toBe(
        true,
      );
    });
  }
  test("rejects missing and duplicate transitions", () => {
    for (const duplicate of [false, true]) {
      const manifest = input();
      if (duplicate) {
        manifest.events.push(manifest.events[0]!);
      } else {
        manifest.events.shift();
      }
      expect(judgeNavigation(manifest).some((finding) => finding.caseName === "transitions")).toBe(
        true,
      );
    }
  });
  test("rejects supported before host opt-in and disabled after registration", () => {
    const manifest = input();
    manifest.capabilities!.beforeRegistration[0]!.state = "SUPPORTED";
    manifest.capabilities!.afterRegistration[1]!.state = "DISABLED";
    expect(
      judgeNavigation(manifest).filter((finding) => finding.caseName.includes("Registration/")),
    ).toHaveLength(2);
  });
  test("requires multi-scene coverage on iPad", () => {
    const manifest = input();
    manifest.navigation!.deviceClass = "ipad";
    expect(judgeNavigation(manifest).some((finding) => finding.caseName === "device-class")).toBe(
      true,
    );
  });
  test("rejects a fake second scene", () => {
    const manifest = input(true);
    manifest.navigation!.sceneIdentifiers[1] = "first";
    expect(judgeNavigation(manifest).some((finding) => finding.caseName === "scenes")).toBe(true);
  });
  test("rejects duplicate and reversed web lifecycle callbacks", () => {
    const manifest = input();
    manifest.events.push(manifest.events[4]!);
    expect(judgeNavigation(manifest).some((finding) => finding.caseName === "webview")).toBe(true);
    manifest.events = [...input().events.slice(0, 4), ...input().events.slice(4).reverse()];
    expect(judgeNavigation(manifest).some((finding) => finding.caseName === "webview")).toBe(true);
  });
  test("rejects malformed SDK payloads and undecodable batches", () => {
    const manifest = input();
    manifest.events[0] = { eventType: "navigation", payload: "invalid" };
    manifest.undecodableBatches = 1;
    expect(
      judgeNavigation(manifest).filter((finding) => finding.boundary === "sdk-serialization"),
    ).toHaveLength(2);
  });
});
