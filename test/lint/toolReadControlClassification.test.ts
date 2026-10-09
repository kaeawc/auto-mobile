import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerMcpTools } from "../../src/server";
import { ToolRegistry, type RegisteredTool } from "../../src/server/toolRegistry";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { serverConfig } from "../../src/utils/ServerConfig";

/**
 * Every device-aware tool is a read or control, and says which (#10965).
 *
 * Owner decisions 2026-10-09: anything that changes visible UI or starts a device-side process is
 * control (owner-only, and use); read-only access never requires a session and is never use. A
 * read is registered `deviceReadOnly: true`; a mixed tool registers a per-args classifier; control
 * is the default. A new device-aware tool used to default to control silently. This table makes
 * the choice explicit: a tool missing from it, or registered differently from it, fails here.
 * `test/server/toolRegistry.readOnlyDeviceAccess.test.ts` proves the reads run on a held device
 * without readiness, and `livenessActivityClockSeparation` rule 6 proves they are never use.
 */

type Args = Record<string, unknown>;

interface Classification {
  readonly read: readonly string[];
  /** Mixed tools: argument sets that must classify as a read, and as control. */
  readonly perArgs: Readonly<Record<string, { reads: readonly Args[]; controls: readonly Args[] }>>;
  readonly control: readonly string[];
}

const PROTOTYPE_ARGS = {
  reads: [{ action: "status" }, { action: "inspect" }],
  controls: [{ action: "show" }, { action: "dismiss" }, { action: "awaitEvent" }],
};

const CLASSIFICATION: Classification = {
  read: [
    "getAppPermissions",
    "getDataStore",
    "getDeepLinks",
    "getDeviceState",
    "getNavigationGraph",
    "getNetworkGraph",
    "getNotificationPolicy",
    "getPreference",
    "hitTest",
    "identifyInteractions",
    "inspectPackageSigning",
    "listApps",
    "listDataStores",
    "observe",
    "snapshotOf",
  ],
  perArgs: {
    accessibility: { reads: [{}], controls: [{ talkback: true }, { voiceover: false }] },
    clipboard: {
      reads: [{ action: "get" }],
      controls: [{ action: "copy", text: "x" }, { action: "paste" }, { action: "clear" }],
    },
    displayConfig: {
      reads: [{}],
      controls: [{ theme: "dark" }, { reset: true }, { fontScale: 1.5 }, { density: 480 }],
    },
    keyboard: {
      reads: [{ action: "detect" }, { action: "listImes" }, { action: "listProfiles" }],
      controls: [
        { action: "open" },
        { action: "close" },
        { action: "setProfile" },
        { action: "setIme" },
        { action: "tapImeKey" },
      ],
    },
    overlay: PROTOTYPE_ARGS,
    prototype: PROTOTYPE_ARGS,
    sqlQuery: {
      reads: [{ query: "SELECT * FROM t" }],
      controls: [{ query: "DELETE FROM t" }, { query: "SELECT 1; DELETE FROM t" }],
    },
  },
  control: [
    "accessibilityFocus",
    "appLifecycle",
    "barrier",
    "biometricAuth",
    "changeLocalization",
    "clearKeyValueFile",
    "clearMockNetwork",
    "crashApp",
    "criticalSection",
    "deviceSnapshot",
    "dragAndDrop",
    "executePlan",
    "explore",
    "highlight",
    "homeScreen",
    "installApp",
    "launchApp",
    "mockNetwork",
    "navigateTo",
    "network",
    "openLink",
    "phoneCall",
    "pinchOn",
    "postNotification",
    "pressButton",
    "putAppFile",
    "recentApps",
    "reconcileDeviceResources",
    "removeKeyValue",
    "resetAppLogs",
    "resetKeychain",
    "rotate",
    "selectAllText",
    "sendKeys",
    "sendSms",
    "setAppPermissions",
    "setDeviceResources",
    "setDeviceState",
    "setKeyValue",
    "setNotificationPolicy",
    "setPosture",
    "setPreference",
    "setUIState",
    "shake",
    "stageSessionDownloads",
    "startTestRecording",
    "swipeOn",
    // Pulls the notification shade down, even to list or find.
    "systemTray",
    "tapAny",
    "tapAt",
    "tapOn",
    "terminateApp",
    "uninstallApp",
    // Starts a device-side recorder.
    "videoRecording",
    "wakeAndUnlock",
  ],
};

type ClassifiedTool = Pick<RegisteredTool, "name" | "deviceReadOnly">;

/** Every way the registered device-aware tools disagree with the classification table. */
function classificationViolations(
  tools: readonly ClassifiedTool[],
  table: Classification,
): string[] {
  const classified = new Set([...table.read, ...Object.keys(table.perArgs), ...table.control]);
  const violations: string[] = [];
  for (const tool of tools) {
    const declared = tool.deviceReadOnly;
    if (!classified.has(tool.name)) {
      violations.push(`${tool.name}: unclassified; add it to read, perArgs or control`);
    } else if (table.read.includes(tool.name) && declared !== true) {
      violations.push(`${tool.name}: listed as a read but not registered deviceReadOnly: true`);
    } else if (table.control.includes(tool.name) && declared !== undefined && declared !== false) {
      violations.push(`${tool.name}: listed as control but registered deviceReadOnly`);
    } else if (tool.name in table.perArgs) {
      violations.push(...perArgsViolations(tool, table.perArgs[tool.name]));
    }
  }
  const registered = new Set(tools.map((tool) => tool.name));
  violations.push(
    ...[...classified]
      .filter((name) => !registered.has(name))
      .map((name) => `${name}: classified but not registered`),
  );
  return violations;
}

function perArgsViolations(
  tool: ClassifiedTool,
  cases: { reads: readonly Args[]; controls: readonly Args[] },
): string[] {
  const classify = tool.deviceReadOnly;
  if (typeof classify !== "function") {
    return [`${tool.name}: listed as per-args but has no per-args classifier`];
  }
  return [
    ...cases.reads
      .filter((args) => classify(args) !== true)
      .map((args) => `${tool.name}: ${JSON.stringify(args)} should be a read`),
    ...cases.controls
      .filter((args) => classify(args) !== false)
      .map((args) => `${tool.name}: ${JSON.stringify(args)} should be control`),
  ];
}

/** The device-aware tools the server registers, including hidden aliases and gated tools. */
function registeredDeviceAwareTools(): ClassifiedTool[] {
  const listed = ToolRegistry.getAllTools({ includeUnavailable: true });
  const hidden = ["overlay"]
    .map((name) => ToolRegistry.getTool(name))
    .filter((tool): tool is RegisteredTool => tool !== undefined);
  return [...listed, ...hidden].filter((tool) => tool.requiresDevice);
}

describe("device-aware tool read/control classification (#10965)", () => {
  let previousDebugMode = false;

  beforeAll(() => {
    previousDebugMode = isDebugModeEnabled();
    // Debug-only and SDK-only tools register their classification like any other.
    setDebugModeEnabled(true);
    serverConfig.setEmbeddedSdkEnabled(true);
    ToolRegistry.clearTools();
    registerMcpTools(true);
  });

  afterAll(() => {
    ToolRegistry.clearTools();
    serverConfig.setEmbeddedSdkEnabled(false);
    setDebugModeEnabled(previousDebugMode);
  });

  test("every registered device-aware tool matches its declared read/control classification", () => {
    const tools = registeredDeviceAwareTools();
    expect(tools.length).toBeGreaterThan(50);
    expect(classificationViolations(tools, CLASSIFICATION)).toEqual([]);
  });

  test("a read is in exactly one list", () => {
    const names = [
      ...CLASSIFICATION.read,
      ...Object.keys(CLASSIFICATION.perArgs),
      ...CLASSIFICATION.control,
    ];
    expect(names.length).toBe(new Set(names).size);
  });

  describe("on a seeded registry", () => {
    const table: Classification = {
      read: ["watch"],
      perArgs: { mixed: { reads: [{ action: "get" }], controls: [{ action: "set" }] } },
      control: ["drive"],
    };
    const mixed = (args: Args) => args.action === "get";

    test("an unclassified new tool fails", () => {
      expect(
        classificationViolations(
          [
            { name: "watch", deviceReadOnly: true },
            { name: "mixed", deviceReadOnly: mixed },
            { name: "drive", deviceReadOnly: undefined },
            { name: "brandNewTool", deviceReadOnly: undefined },
          ],
          table,
        ),
      ).toEqual(["brandNewTool: unclassified; add it to read, perArgs or control"]);
    });

    test("a registration that disagrees with the table fails", () => {
      expect(
        classificationViolations(
          [
            { name: "watch", deviceReadOnly: undefined },
            { name: "mixed", deviceReadOnly: () => true },
            { name: "drive", deviceReadOnly: true },
          ],
          table,
        ),
      ).toEqual([
        "watch: listed as a read but not registered deviceReadOnly: true",
        'mixed: {"action":"set"} should be control',
        "drive: listed as control but registered deviceReadOnly",
      ]);
    });

    test("a classified tool that is no longer registered fails", () => {
      expect(classificationViolations([{ name: "watch", deviceReadOnly: true }], table)).toEqual([
        "mixed: classified but not registered",
        "drive: classified but not registered",
      ]);
    });
  });
});
