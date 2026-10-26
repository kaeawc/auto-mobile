import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type ArtifactCapabilities,
  ADVERTISING_SOURCES,
  UNIMPLEMENTED_BY_ARTIFACT,
  findGaps,
  findStaleExemptions,
  formatGaps,
  parseAndroidAdvertised,
  parseIosRunnerAdvertised,
  parseManifest,
  parsePrototypeAgentAdvertised,
  gatedByScans,
  recordRelease,
  scanHostGates,
  HOST_GATE_SOURCES,
} from "../../scripts/release/lib/artifact-capabilities";
import manifestJson from "../../scripts/release/artifact-capabilities.json";
import { RELEASE_CHECKSUM_REGISTRY } from "../../src/constants/release";

const advertised: ArtifactCapabilities = {
  "android-ctrlproxy-apk": ["tap_double_v1"],
  "ios-runner": ["double_tap_v1"],
  "prototype-agent-dylib": ["prototype_inspect_v1"],
};
const noGates = {
  "android-ctrlproxy-apk": [] as string[],
  "ios-runner": [] as string[],
  "prototype-agent-dylib": [] as string[],
};

describe("artifact capability parsers", () => {
  test("android: reads add() flags, including conditional ones", () => {
    const kotlin = `
      add("node_selector_actions")
      if (sdkInt() >= 30) add("prototype_display_id_v1")
      addAll(registeredRequestTypes)
      add(someVariable)
    `;
    expect(parseAndroidAdvertised(kotlin)).toEqual([
      "node_selector_actions",
      "prototype_display_id_v1",
    ]);
  });

  test("android: expands SystemGlobalActions flagFor() names into global_action flags", () => {
    const kotlin = `
      private fun flagFor(wireName: String) = "global_action_\${wireName}_v1"
      Spec("back", ID, 1, null),
      Spec("lock_screen", ID, API_P, flagFor("lock_screen")),
      Spec("power_dialog", ID, 1, flagFor("power_dialog")),
    `;
    expect(parseAndroidAdvertised(kotlin)).toEqual([
      "global_action_lock_screen_v1",
      "global_action_power_dialog_v1",
    ]);
  });

  test("ios runner: reads enum raw values only", () => {
    const swift = `
      case doubleTapV1 = "double_tap_v1"
      case pathGestureV1 = "path_gesture_v1"
      let other = "not_a_case_v1"
    `;
    expect(parseIosRunnerAdvertised(swift)).toEqual(["double_tap_v1", "path_gesture_v1"]);
  });

  test("prototype agent: reads Capability constants", () => {
    const swift = `
      static let inspectCapability = "prototype_inspect_v1"
      static let version = "1"
    `;
    expect(parsePrototypeAgentAdvertised(swift)).toEqual(["prototype_inspect_v1"]);
  });

  test("prototype agent: reads the standalone persistence replay constant", () => {
    const swift = `static let persistenceReplayCapability = "prototype_persistence_replay_v1"`;
    expect(parsePrototypeAgentAdvertised(swift)).toEqual(["prototype_persistence_replay_v1"]);
  });

  test("real advertising sources yield the capabilities the 0.0.88 gaps named (#15347)", () => {
    const repoRoot = path.resolve(import.meta.dir, "../..");
    const read = (artifact: keyof typeof ADVERTISING_SOURCES): string =>
      ADVERTISING_SOURCES[artifact]
        .map((file) => readFileSync(path.join(repoRoot, file), "utf8"))
        .join("\n");
    expect(parseAndroidAdvertised(read("android-ctrlproxy-apk"))).toEqual(
      expect.arrayContaining([
        "global_action_dismiss_notification_shade_v1",
        "global_action_lock_screen_v1",
        "global_action_power_dialog_v1",
        "global_action_quick_settings_v1",
        "global_action_screenshot_v1",
        "global_action_split_screen_v1",
      ]),
    );
    expect(parsePrototypeAgentAdvertised(read("prototype-agent-dylib"))).toContain(
      "prototype_persistence_replay_v1",
    );
  });

  test("host: reads versioned literals in code and ignores unversioned strings", () => {
    const ts = `
      features.includes("path_gesture_v1");
      const list = ["prototype_refresh_v1"];
      const y = "display_cutout_info";
    `;
    expect(scanHostGates(ts).literals).toEqual(["path_gesture_v1", "prototype_refresh_v1"]);
  });

  test("host: comments never count as gates", () => {
    const ts = `
      // features.includes("commented_out_v1")
      /* "block_comment_v1" */
      const a = 1;
    `;
    expect(scanHostGates(ts).literals).toEqual([]);
  });

  test("host: a declared constant is a gate only where it is referenced", () => {
    const declaring = scanHostGates(
      `export const DRAG_CAPABILITY = "prototype_bottom_sheet_drag_v1";`,
    );
    const consumer = scanHostGates(`supports(DRAG_CAPABILITY); const toString = 1;`);
    const declared = declaring.declared;
    expect(declared).toEqual({ DRAG_CAPABILITY: "prototype_bottom_sheet_drag_v1" });
    expect(gatedByScans([declaring], declared)).toEqual([]);
    expect(gatedByScans([declaring, consumer], declared)).toEqual([
      "prototype_bottom_sheet_drag_v1",
    ]);
  });

  test("dylib gate sources include the shared storage gate files", () => {
    expect(HOST_GATE_SOURCES["prototype-agent-dylib"]).toContain(
      "src/features/prototype/prototypeStorage.ts",
    );
  });
});

describe("findGaps", () => {
  test("reports gated names an artifact does not advertise", () => {
    const gaps = findGaps(advertised, {
      ...noGates,
      "android-ctrlproxy-apk": ["tap_double_v1", "multi_finger_gesture_v1"],
      "ios-runner": ["path_gesture_v1"],
    });
    expect(gaps).toEqual([
      { artifact: "android-ctrlproxy-apk", capability: "multi_finger_gesture_v1" },
      { artifact: "ios-runner", capability: "path_gesture_v1" },
    ]);
    expect(formatGaps("0.0.9", gaps)).toContain("- ios-runner: path_gesture_v1");
  });

  test("no gaps when every gate is advertised", () => {
    expect(findGaps(advertised, { ...noGates, "ios-runner": ["double_tap_v1"] })).toEqual([]);
  });

  test("an artifact's capabilities do not satisfy another artifact's gate", () => {
    const gaps = findGaps(advertised, { ...noGates, "ios-runner": ["tap_double_v1"] });
    expect(gaps).toHaveLength(1);
  });
});

describe("exemptions", () => {
  const exempt = {
    "android-ctrlproxy-apk": {},
    "ios-runner": {},
    "prototype-agent-dylib": { prototype_platform_v1: "no module registry" },
  };

  test("a deliberately unimplemented gate is not a gap", () => {
    expect(
      findGaps(
        advertised,
        { ...noGates, "prototype-agent-dylib": ["prototype_platform_v1"] },
        exempt,
      ),
    ).toEqual([]);
  });

  test("an exemption is scoped to its own artifact", () => {
    const gaps = findGaps(
      advertised,
      { ...noGates, "android-ctrlproxy-apk": ["prototype_platform_v1"] },
      exempt,
    );
    expect(gaps).toEqual([
      { artifact: "android-ctrlproxy-apk", capability: "prototype_platform_v1" },
    ]);
  });

  test("an exemption for a capability the artifact now advertises is stale", () => {
    const withIt: ArtifactCapabilities = {
      ...advertised,
      "prototype-agent-dylib": ["prototype_platform_v1"],
    };
    expect(findStaleExemptions(withIt, exempt)).toEqual([
      { artifact: "prototype-agent-dylib", capability: "prototype_platform_v1" },
    ]);
    expect(findStaleExemptions(advertised, exempt)).toEqual([]);
  });

  test("every checked-in exemption states a reason", () => {
    for (const reasons of Object.values(UNIMPLEMENTED_BY_ARTIFACT)) {
      for (const reason of Object.values(reasons)) {
        expect(reason.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("manifest", () => {
  test("rejects a release missing an artifact", () => {
    const raw = JSON.stringify({ releases: { "1.0.0": { "ios-runner": [] } } });
    expect(() => parseManifest(raw)).toThrow("missing artifact");
  });

  test("checked-in manifest is well formed and records the newest pinned release", () => {
    const manifest = parseManifest(JSON.stringify(manifestJson));
    expect(Object.keys(manifest.releases)).toContain(RELEASE_CHECKSUM_REGISTRY[0].version);
  });
});

describe("recordRelease", () => {
  test("re-recording an existing version replaces its stale entry and keeps newest-first order", () => {
    const stale: ArtifactCapabilities = { ...advertised, "ios-runner": ["old_v1"] };
    const manifest = {
      description: "Test releases",
      releases: { "1.0.0": advertised, "0.9.0": stale },
    };
    const next = recordRelease(manifest, "0.9.0", advertised);
    expect(next.releases["0.9.0"]).toEqual(advertised);
    expect(Object.keys(next.releases)).toEqual(["0.9.0", "1.0.0"]);
  });
});
