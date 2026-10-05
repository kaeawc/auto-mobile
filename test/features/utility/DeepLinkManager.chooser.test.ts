import { logger } from "../../../src/utils/logger";
import { loggerCallsWithPrefix } from "../../helpers/loggerCallsWithPrefix";
import { describe, expect, spyOn, test } from "bun:test";
import {
  DeepLinkManager,
  resolveChooserActivityLabel,
  type ChooserAppMetadata,
  type ChooserActivityLabelResult,
} from "../../../src/features/utility/DeepLinkManager";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const metadata = (
  label: string | null,
  nodes: unknown[],
  packageName?: string,
  listId?: string,
  activityLabel?: ChooserActivityLabelResult | string | null,
): ChooserAppMetadata => ({
  getLabel: async () => label,
  getActivityLabel: async () =>
    typeof activityLabel === "string"
      ? { kind: "literal", label: activityLabel }
      : (activityLabel ?? { kind: "none" }),
  getFreshHierarchy: async (_device, _factory, minTimestamp) =>
    ({
      ...hierarchy(nodes, listId),
      packageName: minTimestamp > 101 ? target : packageName,
      updatedAt: Math.max(101, minTimestamp),
      hierarchy: minTimestamp > 101 ? { node: {} } : hierarchy(nodes, listId).hierarchy,
    }) as any,
});

const target = "com.example.app";

const chromeQueryActivities = `1 activities found:
  Activity #0:
    priority=0 preferredOrder=0 match=0x208000 specificIndex=-1 isDefault=true
    ActivityInfo:
      name=com.google.android.apps.chrome.IntentDispatcher
      packageName=com.android.chrome
      enabled=true exported=true directBootAware=false
      taskAffinity=null targetActivity=org.chromium.chrome.browser.document.ChromeLauncherActivity persistableMode=PERSIST_ROOT_ONLY
      launchMode=LAUNCH_MULTIPLE flags=0x311220 privateFlags=0x2 theme=0x7f150219
      screenOrientation=-1 configChanges=0x1fb3 softInputMode=0x0
      lockTaskLaunchMode=LOCK_TASK_LAUNCH_MODE_DEFAULT
      resizeMode=RESIZE_MODE_RESIZEABLE_VIA_SDK_VERSION
      knownActivityEmbeddingCerts={}
      requireContentUriPermissionFromCaller=CONTENT_URI_PERMISSION_NONE
      ApplicationInfo:
        name=org.chromium.chrome.browser.base.SplitChromeApplication
        packageName=com.android.chrome
        labelRes=0x7f1402c9 nonLocalizedLabel=null icon=0x7f090311 banner=0x0
        className=org.chromium.chrome.browser.base.SplitChromeApplication
        processName=com.android.chrome
        taskAffinity=com.android.chrome
        uid=10153 flags=0xa0cbbec5 privateFlags=0x84089110 theme=0x0
        requiresSmallestWidthDp=0 compatibleWidthLimitDp=0 largestWidthLimitDp=0
        sourceDir=/data/app/~~afYmDKAAY_-ODyVPxkmJ_g==/com.android.chrome-fA7oSWp6s_POwN2v4WbjQg==/Chrome.apk
        resourceDirs=[/product/overlay/EmulationPixel7/EmulationPixel7Overlay.apk, /product/overlay/NavigationBarModeGestural/NavigationBarModeGesturalOverlay.apk]
        overlayPaths=[/product/overlay/EmulationPixel7/EmulationPixel7Overlay.apk, /product/overlay/NavigationBarModeGestural/NavigationBarModeGesturalOverlay.apk]
        seinfo=default:targetSdkVersion=34:partition=product
        seinfoUser=:complete
        dataDir=/data/user/0/com.android.chrome
        deviceProtectedDataDir=/data/user_de/0/com.android.chrome
        credentialProtectedDataDir=/data/user/0/com.android.chrome
        sharedLibraryFiles=[/data/app/~~irmkDV_t22eDqWE3B405IA==/com.google.android.trichromelibrary_694313732-YasP6Id9bpKXd-s54WyXzA==/TrichromeLibrary.apk]
        enabled=true minSdkVersion=29 targetSdkVersion=34 versionCode=694313732 targetSandboxVersion=1
        manageSpaceActivityName=org.chromium.chrome.browser.site_settings.ManageSpaceActivity
        supportsRtl=true
        fullBackupContent=true
        crossProfile=false
        networkSecurityConfigRes=0x7f18002c
        category=7
        HiddenApiEnforcementPolicy=2
        usesNonSdkApi=false
        allowsPlaybackCapture=false
        memtagMode=1
        nativeHeapZeroInitialized=0
        localeConfigRes=0x7f180026
        enableOnBackInvokedCallback=true
        allowCrossUidActivitySwitchFromBelow=true
        mPageSizeAppCompatFlags=0
        createTimestamp=5530718
`;

describe("ADB activity-label lookup", () => {
  test("prefers a literal ResolveInfo label over a different ActivityInfo label", async () => {
    const adb = new FakeAdbExecutor();
    const labeledQuery = chromeQueryActivities
      .replace(
        "    ActivityInfo:",
        "    labelRes=0x7f010002 nonLocalizedLabel=Open in Chrome icon=0x7f090311\n    ActivityInfo:",
      )
      .replace(
        "      ApplicationInfo:",
        "      labelRes=0x7f010001 nonLocalizedLabel=Chrome Activity icon=0x7f090311\n      ApplicationInfo:",
      );
    adb.setCommandResponse("query-activities", { stdout: labeledQuery, stderr: "" } as any);

    expect(
      await resolveChooserActivityLabel(adb, "com.android.chrome", "https://example.com"),
    ).toEqual({ kind: "literal", label: "Open in Chrome" });
  });

  test("real Chrome query fixture has no activity label despite application label fields", async () => {
    const adb = new FakeAdbExecutor();
    expect(chromeQueryActivities).toContain("      ApplicationInfo:\n");
    expect(chromeQueryActivities).toContain(
      "        labelRes=0x7f1402c9 nonLocalizedLabel=null icon=0x7f090311 banner=0x0",
    );
    adb.setCommandResponse("query-activities", {
      stdout: chromeQueryActivities,
      stderr: "",
    } as any);

    expect(
      await resolveChooserActivityLabel(adb, "com.android.chrome", "https://example.com"),
    ).toEqual({ kind: "none" });
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd package query-activities -a android.intent.action.VIEW -d 'https://example.com'",
    ]);
  });

  test("reads a literal ActivityInfo label from the real query structure for a quoted URL", async () => {
    const adb = new FakeAdbExecutor();
    const labeledQuery = chromeQueryActivities.replace(
      "      ApplicationInfo:",
      "      labelRes=0x7f010001 nonLocalizedLabel=Open in Browser icon=0x7f090311\n      ApplicationInfo:",
    );
    adb.setCommandResponse("query-activities", { stdout: labeledQuery, stderr: "" } as any);

    expect(
      await resolveChooserActivityLabel(adb, "com.android.chrome", "example://item?q='x'&v=$HOME"),
    ).toEqual({ kind: "literal", label: "Open in Browser" });
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd package query-activities -a android.intent.action.VIEW -d 'example://item?q='\\''x'\\''&v=$HOME'",
    ]);
  });

  test("returns null when two VIEW activities from the same package match", async () => {
    const adb = new FakeAdbExecutor();
    const firstActivity = chromeQueryActivities
      .slice(chromeQueryActivities.indexOf("  Activity #0:"))
      .replace(
        "      ApplicationInfo:",
        "      labelRes=0x7f010001 nonLocalizedLabel=Open in Browser icon=0x7f090311\n      ApplicationInfo:",
      );
    const secondActivity = firstActivity
      .replace("Activity #0:", "Activity #1:")
      .replace("IntentDispatcher", "OtherDispatcher")
      .replace("Open in Browser", "Open in Other");
    const twoActivities = `2 activities found:\n${firstActivity}${secondActivity}`;
    adb.setCommandResponse("query-activities", { stdout: twoActivities, stderr: "" } as any);

    expect(
      await resolveChooserActivityLabel(adb, "com.android.chrome", "https://example.com"),
    ).toEqual({ kind: "none" });
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });

  test("ignores a literal ApplicationInfo label when ActivityInfo has none", async () => {
    const adb = new FakeAdbExecutor();
    const appLabeledQuery = chromeQueryActivities.replace(
      "nonLocalizedLabel=null icon=0x7f090311",
      "nonLocalizedLabel=Application Only icon=0x7f090311",
    );
    adb.setCommandResponse("query-activities", { stdout: appLabeledQuery, stderr: "" } as any);

    expect(
      await resolveChooserActivityLabel(adb, "com.android.chrome", "https://example.com"),
    ).toEqual({ kind: "none" });
  });

  test("does not invent a label for a resource-backed activity", async () => {
    const adb = new FakeAdbExecutor();
    const resourceLabeledQuery = chromeQueryActivities.replace(
      "      ApplicationInfo:",
      "      labelRes=0x7f010001 nonLocalizedLabel=null icon=0x7f090311\n      ApplicationInfo:",
    );
    adb.setCommandResponse("query-activities", { stdout: resourceLabeledQuery, stderr: "" } as any);

    expect(
      await resolveChooserActivityLabel(adb, "com.android.chrome", "https://example.com"),
    ).toEqual({ kind: "resource" });
  });

  test("keeps a resource-backed ResolveInfo label ahead of a literal ActivityInfo label", async () => {
    const adb = new FakeAdbExecutor();
    const query = chromeQueryActivities
      .replace(
        "    ActivityInfo:",
        "    labelRes=0x7f010002 nonLocalizedLabel=null icon=0x7f090311\n    ActivityInfo:",
      )
      .replace(
        "      ApplicationInfo:",
        "      labelRes=0x7f010001 nonLocalizedLabel=Chrome Activity icon=0x7f090311\n      ApplicationInfo:",
      );
    adb.setCommandResponse("query-activities", { stdout: query, stderr: "" } as any);

    expect(
      await resolveChooserActivityLabel(adb, "com.android.chrome", "https://example.com"),
    ).toEqual({ kind: "resource" });
  });
});

const row = (packageName: string, top: number) => ({
  clickable: true,
  bounds: { left: 0, top, right: 100, bottom: top + 40 },
  node: [
    {
      "resource-id": `${packageName}:id/title`,
      text: packageName,
      bounds: { left: 5, top: top + 5, right: 35, bottom: top + 15 },
    },
  ],
});
const hierarchy = (nodes: unknown[], listId = "android:id/resolver_list") => ({
  updatedAt: 100,
  hierarchy: {
    node: {
      class: "com.android.internal.app.ChooserActivity",
      node: [{ "resource-id": listId, node: nodes }],
    },
  },
});

async function choose(
  nodes: unknown[],
  label: string | null = null,
  listId?: string,
  activityLabel?: ChooserActivityLabelResult | string | null,
  url?: string,
) {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    metadata(label, nodes, undefined, listId, activityLabel),
  );
  const result = await manager.handleIntentChooser(
    hierarchy(nodes, listId) as any,
    "custom",
    target,
    url,
  );
  return { result, commands: adb.getExecutedCommands() };
}

describe("custom intent chooser exact package selection", () => {
  for (const reverse of [false, true]) {
    test(`selects exact package and taps clickable row (reverse=${reverse})`, async () => {
      const rows = [row(`${target}.beta`, 0), row(target, 100)];
      const { result, commands } = await choose(reverse ? rows.reverse() : rows);
      expect(result.success).toBe(true);
      expect(result.packageVerified).toBe(true);
      expect(result.tappedAt).toBeUndefined();
      expect(commands).toEqual(["shell input tap 50 120"]);
    });
  }
  test("rejects ambiguous rows without tapping", async () => {
    const { result, commands } = await choose([row(target, 0), row(target, 100)]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Ambiguous");
    expect(result.error).toContain(target);
    expect(commands).toEqual([]);
  });
  test("rejects an exact package repeated on a later chooser page", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceTimestampMs(1000);
    const first = hierarchy([row(target, 0)]);
    (first.hierarchy.node.node[0] as any).bounds = { left: 0, top: 0, right: 100, bottom: 200 };
    const later = hierarchy([row(target, 0), row("com.other.app", 100)]);
    const manager = new DeepLinkManager(
      { platform: "android", deviceId: "fake", name: "fake" },
      adb,
      null,
      null,
      undefined,
      undefined,
      {
        getLabel: async () => null,
        getFreshHierarchy: async () => ({ ...later, updatedAt: 101 }) as any,
      },
    );
    const result = await manager.handleIntentChooser(first as any, "custom", target);
    expect(result.error).toContain("Ambiguous chooser rows");
    expect(
      adb.getExecutedCommands().filter((command) => command.startsWith("shell input tap")),
    ).toEqual([]);
  });
  test("restores an earlier unique row after scanning later pages", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceTimestampMs(1000);
    const makePage = (items: unknown[], updatedAt: number) => ({
      updatedAt,
      hierarchy: {
        node: {
          class: "com.android.internal.app.ChooserActivity",
          node: [
            {
              "resource-id": "android:id/resolver_list",
              bounds: { left: 0, top: 0, right: 100, bottom: 200 },
              node: items,
            },
          ],
        },
      },
    });
    const first = makePage([row(target, 0)], 100);
    const second = makePage([row("com.other.app", 100)], 101);
    let captures = 0;
    const manager = new DeepLinkManager(
      { platform: "android", deviceId: "fake", name: "fake" },
      adb,
      null,
      null,
      undefined,
      undefined,
      {
        getLabel: async () => null,
        getFreshHierarchy: async (_device, _factory, floor) =>
          ({ ...(++captures <= 3 ? second : first), updatedAt: floor }) as any,
      },
    );
    const result = await manager.handleIntentChooser(first as any, "custom", target);
    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([
      "shell input swipe 50 150 50 50 350",
      "shell input swipe 50 150 50 50 350",
      "shell input swipe 50 50 50 150 350",
      "shell input tap 50 20",
    ]);
  });
  test("does not accept a package substring in unrelated text", async () => {
    const { result, commands } = await choose([
      row(`${target}.beta`, 0),
      { text: `Open ${target} now` },
    ]);
    expect(result.success).toBe(false);
    expect(commands.filter((command) => command.startsWith("shell input tap"))).toEqual([]);
  });
});

describe("custom intent chooser label fallback", () => {
  const labelRow = (label: string, top: number) => ({
    ...row("android", top),
    node: [{ text: label, package: "android" }],
  });
  test("uses the resolved activity label when it differs from the application label", async () => {
    const { result, commands } = await choose(
      [labelRow("Activity Name", 100)],
      "Application Name",
      undefined,
      "Activity Name",
      "example://item",
    );
    expect(result.success).toBe(true);
    expect(commands).toEqual(["shell input tap 50 120"]);
  });
  test("falls back to the application label when the activity label is unavailable", async () => {
    const { result, commands } = await choose(
      [labelRow("Application Name", 100)],
      "Application Name",
      undefined,
      null,
      "example://item",
    );
    expect(result.success).toBe(true);
    expect(commands).toEqual(["shell input tap 50 120"]);
  });
  test("tries the application label after a literal activity label misses every row", async () => {
    const { result, commands } = await choose(
      [labelRow("Application Name", 100)],
      "Application Name",
      undefined,
      "Activity Name",
      "example://item",
    );
    expect(result.success).toBe(true);
    expect(commands).toEqual(["shell input tap 50 120"]);
  });
  test("does not retry the application label when the activity label is ambiguous", async () => {
    const { result, commands } = await choose(
      [
        labelRow("Activity Name", 0),
        labelRow("Activity Name", 50),
        labelRow("Application Name", 100),
      ],
      "Application Name",
      undefined,
      "Activity Name",
      "example://item",
    );
    expect(result.error).toContain("Ambiguous chooser rows");
    expect(commands).toEqual([]);
  });
  test("never substitutes the application label for a resource-backed activity", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceTimestampMs(1000);
    const query = chromeQueryActivities.replace(
      "      ApplicationInfo:",
      "      labelRes=0x7f010001 nonLocalizedLabel=null icon=0x7f090311\n      ApplicationInfo:",
    );
    adb.setCommandResponse("query-activities", { stdout: query, stderr: "" } as any);
    const rows = [labelRow("Application Name", 100)];
    const manager = new DeepLinkManager(
      { platform: "android", deviceId: "fake", name: "fake" },
      adb,
      null,
      null,
      undefined,
      undefined,
      {
        ...metadata("Application Name", rows),
        getActivityLabel: async (_device, packageName, url, executor) =>
          resolveChooserActivityLabel(executor, packageName, url),
      },
    );
    const result = await manager.handleIntentChooser(
      hierarchy(rows) as any,
      "custom",
      "com.android.chrome",
      "example://item",
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("No exact clickable chooser row");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd package query-activities -a android.intent.action.VIEW -d 'example://item'",
    ]);
  });
  test("matches the resolved label exactly and promotes its row", async () => {
    const { result, commands } = await choose(
      [labelRow("Example Beta", 0), labelRow("Example", 100)],
      "Example",
    );
    expect(result.success).toBe(true);
    expect(result.packageVerified).toBe(false);
    expect(commands).toEqual(["shell input tap 50 120"]);
  });
  test("rejects a label-only tap when its timestamp falls back to the host clock", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceTimestampMs(null);
    let captures = 0;
    const chooser = hierarchy([labelRow("Example", 100)]);
    const manager = new DeepLinkManager(
      { platform: "android", deviceId: "fake", name: "fake" },
      adb,
      null,
      null,
      undefined,
      undefined,
      {
        getLabel: async () => "Example",
        getFreshHierarchy: async () => {
          captures += 1;
          return { ...chooser, updatedAt: 101 } as any;
        },
      },
    );
    const result = await manager.handleIntentChooser(chooser as any, "custom", target);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unverified chooser selection");
    expect(result.packageVerified).toBe(false);
    expect(result.tappedAt).toBeUndefined();
    expect(captures).toBe(1);
    expect(adb.getExecutedCommands()).toEqual(["shell input tap 50 120"]);
  });
  test("margins a device-seconds tap before confirming a label-only selection", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceTimestampMs(1000);
    adb.setDeviceTimestampSource("device-seconds");
    const floors: number[] = [];
    const chooser = hierarchy([labelRow("Example", 100)]);
    const manager = new DeepLinkManager(
      { platform: "android", deviceId: "fake", name: "fake" },
      adb,
      null,
      null,
      undefined,
      undefined,
      {
        getLabel: async () => "Example",
        getFreshHierarchy: async (_device, _factory, floor) => {
          floors.push(floor);
          return (
            floor === 101
              ? { ...chooser, updatedAt: 101 }
              : { hierarchy: { node: {} }, packageName: target, updatedAt: 2000 }
          ) as any;
        },
      },
    );
    const result = await manager.handleIntentChooser(chooser as any, "custom", target);
    expect(result.success).toBe(true);
    expect(result.packageVerified).toBe(false);
    // Expose the raw second; only the internal polling floor advances to 2000.
    expect(result.tappedAt).toBe(1000);
    expect(floors).toEqual([101, 2000]);
  });
  test("does not claim a shared-label row selected the requested package", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceTimestampMs(1000);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new DeepLinkManager(
      { platform: "android", deviceId: "fake", name: "fake" },
      adb,
      null,
      null,
      undefined,
      undefined,
      {
        getLabel: async () => "Shared",
        getFreshHierarchy: async (_device, _factory, floor) =>
          (floor <= 101
            ? { ...hierarchy([labelRow("Shared", 100)]), updatedAt: 101 }
            : {
                ...hierarchy([]),
                hierarchy: { node: {} },
                packageName: "com.other.app",
                updatedAt: floor,
              }) as any,
      },
      timer,
    );
    const result = await manager.handleIntentChooser(
      hierarchy([labelRow("Shared", 100)]) as any,
      "custom",
      target,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unverified chooser selection");
  });
  test("matches a label-only row in the legacy android:id/list container", async () => {
    const { result, commands } = await choose(
      [labelRow("Example Beta", 0), labelRow("Example", 100)],
      "Example",
      "android:id/list",
    );
    expect(result.success).toBe(true);
    expect(commands).toEqual(["shell input tap 50 120"]);
  });
  test("scrolls and recaptures bounded chooser pages before declaring a label-only row missing", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceTimestampMs(1000);
    const page = (nodes: unknown[], updatedAt: number) => ({
      updatedAt,
      hierarchy: {
        node: {
          class: "com.android.internal.app.ChooserActivity",
          node: [
            {
              "resource-id": "android:id/resolver_list",
              bounds: { left: 0, top: 0, right: 100, bottom: 200 },
              node: nodes,
            },
          ],
        },
      },
    });
    const first = page([labelRow("Example Beta", 100)], 100);
    const second = page([labelRow("Example", 100)], 102);
    const manager = new DeepLinkManager(
      { platform: "android", deviceId: "fake", name: "fake" },
      adb,
      null,
      null,
      undefined,
      undefined,
      {
        getLabel: async () => "Example",
        getFreshHierarchy: async (_device, _factory, minTimestamp) =>
          (minTimestamp >= 1000
            ? { ...second, hierarchy: { node: {} }, packageName: target, updatedAt: minTimestamp }
            : { ...(minTimestamp <= 101 ? first : second), updatedAt: minTimestamp }) as any,
      },
    );
    const result = await manager.handleIntentChooser(first as any, "custom", target);
    expect(adb.getExecutedCommands()).toEqual([
      "shell input swipe 50 150 50 50 350",
      "shell input swipe 50 150 50 50 350",
      "shell input tap 50 120",
    ]);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });
  test("rematches a moved row after the label lookup before tapping", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceTimestampMs(1000);
    const manager = new DeepLinkManager(
      { platform: "android", deviceId: "fake", name: "fake" },
      adb,
      null,
      null,
      undefined,
      undefined,
      metadata("Example", [labelRow("Example", 200), labelRow("Example Beta", 0)]),
    );
    const result = await manager.handleIntentChooser(
      hierarchy([labelRow("Example", 100), labelRow("Example Beta", 0)]) as any,
      "custom",
      target,
    );
    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands()).toEqual(["shell input tap 50 220"]);
  });
  test("rejects a cached chooser instead of tapping stale coordinates", async () => {
    const adb = new FakeAdbExecutor();
    let requestedTimestamp = 0;
    const manager = new DeepLinkManager(
      { platform: "android", deviceId: "fake", name: "fake" },
      adb,
      null,
      null,
      undefined,
      undefined,
      {
        getLabel: async () => "Example",
        getFreshHierarchy: async (_device, _factory, minTimestamp) => {
          requestedTimestamp = minTimestamp;
          return hierarchy([labelRow("Example", 100)]) as any;
        },
      },
    );
    const result = await manager.handleIntentChooser(
      hierarchy([labelRow("Example", 100)]) as any,
      "custom",
      target,
    );
    expect(requestedTimestamp).toBe(101);
    expect(result.error).toContain("did not refresh");
    expect(adb.getExecutedCommands()).toEqual([]);
  });
  test("ignores an action button named like the requested app", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceTimestampMs(1000);
    const fresh = {
      updatedAt: 101,
      hierarchy: {
        node: {
          class: "com.android.internal.app.ChooserActivity",
          node: [
            {
              clickable: true,
              text: "Always",
              bounds: { left: 0, top: 0, right: 100, bottom: 40 },
            },
            { "resource-id": "android:id/resolver_list", node: [labelRow("Always", 100)] },
          ],
        },
      },
    };
    const manager = new DeepLinkManager(
      { platform: "android", deviceId: "fake", name: "fake" },
      adb,
      null,
      null,
      undefined,
      undefined,
      {
        getLabel: async () => "Always",
        getFreshHierarchy: async (_device, _factory, floor) =>
          (floor > 101
            ? { hierarchy: { node: {} }, packageName: target, updatedAt: floor }
            : fresh) as any,
      },
    );
    const result = await manager.handleIntentChooser(
      hierarchy([labelRow("Always", 100)]) as any,
      "custom",
      target,
    );
    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands()).toEqual(["shell input tap 50 120"]);
  });
  test("falls back to a label-only row when another row carries package metadata", async () => {
    const { result, commands } = await choose(
      [row(`${target}.beta`, 0), labelRow("Example", 100)],
      "Example",
    );
    expect(result.success).toBe(true);
    expect(commands).toEqual(["shell input tap 50 120"]);
  });
  test("does not match a label on a row with conflicting package metadata", async () => {
    const { result, commands } = await choose([row(`${target}.beta`, 0)], `${target}.beta`);
    expect(result.success).toBe(false);
    expect(commands).toEqual([]);
  });
  test("rejects duplicate exact labels", async () => {
    const { result, commands } = await choose(
      [labelRow("Example", 0), labelRow("Example", 100)],
      "Example",
    );
    expect(result.error).toContain("Ambiguous");
    expect(result.error).toContain("bounds=");
    expect(commands).toEqual([]);
  });
  test("rejects missing label metadata without tapping", async () => {
    const { result, commands } = await choose([labelRow("Example", 0)]);
    expect(result.error).toContain("No exact clickable chooser row");
    expect(commands).toEqual([]);
  });
  test("deduplicates matching descendants within the same row", async () => {
    const exactRow = row(target, 100);
    exactRow.node.push({ ...exactRow.node[0], "resource-id": `${target}:id/subtitle` });
    const { result, commands } = await choose([exactRow]);
    expect(result.success).toBe(true);
    expect(commands).toEqual(["shell input tap 50 120"]);
  });
  test("accepts exact package metadata independently of the resource ID", async () => {
    const { result, commands } = await choose([{ ...labelRow("Example", 100), package: target }]);
    expect(result.success).toBe(true);
    expect(commands).toEqual(["shell input tap 50 120"]);
  });
});

test("rejects ambiguity across hierarchy roots", async () => {
  const adb = new FakeAdbExecutor();
  const manager = new DeepLinkManager({ platform: "android", deviceId: "fake", name: "fake" }, adb);
  const result = await manager.handleIntentChooser(
    {
      updatedAt: 100,
      hierarchy: {
        node: [
          {
            class: "com.android.internal.app.ChooserActivity",
            node: [{ "resource-id": "android:id/resolver_list", node: [row(target, 0)] }],
          },
          { node: [{ "resource-id": "android:id/chooser_list", node: [row(target, 100)] }] },
        ],
      },
    } as any,
    "custom",
    target,
  );
  expect(result.error).toContain("Ambiguous");
  expect(adb.getExecutedCommands()).toEqual([]);
});

test("ignores exact package metadata outside the chooser app list", async () => {
  const adb = new FakeAdbExecutor();
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    metadata("Example", [row(target, 100)]),
  );
  const result = await manager.handleIntentChooser(
    {
      ...hierarchy([row(target, 100)]),
      hierarchy: {
        node: [
          { class: "com.android.internal.app.ChooserActivity", node: [row(target, 0)] },
          { "resource-id": "android:id/resolver_list", node: [row(target, 100)] },
        ],
      },
    } as any,
    "custom",
    target,
  );
  expect(result.success).toBe(true);
  expect(adb.getExecutedCommands()).toEqual(["shell input tap 50 120"]);
});

test("taps parsed clickable row bounds in XML-wrapped hierarchies", async () => {
  const exactRow = row(target, 100);
  const { result, commands } = await choose([
    {
      $: { clickable: "true", bounds: exactRow.bounds },
      node: exactRow.node.map((node) => ({ $: node })),
    },
  ]);
  expect(result.success).toBe(true);
  expect(commands).toEqual(["shell input tap 50 120"]);
});

test("rejects an exact clickable row without usable bounds", async () => {
  const { result, commands } = await choose([{ clickable: true, package: target }]);
  expect(result.error).toContain("no usable bounds");
  expect(commands).toEqual([]);
});

test("excludes a captured OEM chooser host from represented app metadata", async () => {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  const host = "com.vendor.intentresolver";
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    metadata(
      "Example",
      [
        {
          ...row(host, 0),
          node: [{ package: host, "resource-id": `${host}:id/title`, text: "Example Beta" }],
        },
        {
          ...row(host, 100),
          node: [{ package: host, "resource-id": `${host}:id/title`, text: "Example" }],
        },
      ],
      host,
    ),
  );
  const result = await manager.handleIntentChooser(
    {
      updatedAt: 100,
      hierarchy: {
        node: {
          $: { class: "com.android.internal.app.ChooserActivity" },
          node: [
            {
              ...row(host, 0),
              node: [{ package: host, "resource-id": `${host}:id/title`, text: "Example Beta" }],
            },
            {
              ...row(host, 100),
              node: [{ package: host, "resource-id": `${host}:id/title`, text: "Example" }],
            },
          ],
        },
      },
      packageName: host,
    } as any,
    "custom",
    target,
  );
  expect(result.success).toBe(true);
  expect(adb.getExecutedCommands()).toEqual(["shell input tap 50 120"]);
});

const chooserPage = (nodes: unknown[], updatedAt: number) => ({
  updatedAt,
  hierarchy: {
    node: {
      class: "com.android.internal.app.ChooserActivity",
      node: [
        {
          "resource-id": "android:id/resolver_list",
          bounds: { left: 0, top: 0, right: 100, bottom: 200 },
          node: nodes,
        },
      ],
    },
  },
});

test("retries a fresh chooser and intermediate screen until the target app launches", async () => {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const floors: number[] = [];
  const chooser = chooserPage([{ ...row("android", 100), node: [{ text: "Example" }] }], 100);
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor) => {
        floors.push(floor);
        if (floor < 1000) {
          return { ...chooser, updatedAt: floor } as any;
        }
        if (floor === 1000) {
          return { ...chooser, updatedAt: 1000 } as any;
        }
        if (floor === 1001) {
          return { hierarchy: { node: {} }, packageName: "com.loading", updatedAt: 1001 } as any;
        }
        return { hierarchy: { node: {} }, packageName: target, updatedAt: floor } as any;
      },
    },
    timer,
  );
  const result = await manager.handleIntentChooser(chooser as any, "custom", target);
  expect(result.success).toBe(true);
  expect(floors).toEqual([101, 102, 1000, 1001, 1002]);
  expect(timer.getSleepHistory()).toEqual([50, 50]);
});

test("bounds post-tap polling and returns the typed unverified failure", async () => {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const chooser = chooserPage([{ ...row("android", 100), node: [{ text: "Example" }] }], 100);
  const floors: number[] = [];
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor) => {
        floors.push(floor);
        return { ...chooser, updatedAt: floor } as any;
      },
    },
    timer,
  );
  const result = await manager.handleIntentChooser(chooser as any, "custom", target);
  expect(result.success).toBe(false);
  expect(result.error).toContain("Unverified chooser selection");
  expect(result.tappedAt).toBe(1000);
  expect(floors).toEqual([101, 102, 1000, 1001, 1002, 1003]);
  expect(timer.getSleepHistory()).toEqual([50, 50, 50, 50]);
});

test("bounds a slow post-tap hierarchy read by the remaining verification budget", async () => {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const chooser = chooserPage([{ ...row("android", 100), node: [{ text: "Example" }] }], 100);
  const readBudgets: number[] = [];
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor, timeoutMs) => {
        if (floor < 1000) {
          return { ...chooser, updatedAt: floor } as any;
        }
        readBudgets.push(timeoutMs ?? 0);
        if (readBudgets.length === 1) {
          return { hierarchy: { node: {} }, packageName: "com.other.app", updatedAt: floor } as any;
        }
        await timer.sleep(Math.min(11_000, timeoutMs ?? 11_000));
        return { hierarchy: { node: {} }, packageName: "com.other.app", updatedAt: floor } as any;
      },
    },
    timer,
  );
  const result = await manager.handleIntentChooser(chooser as any, "custom", target);
  expect(result.success).toBe(false);
  expect(result.error).toContain("Unverified chooser selection");
  expect(result.packageVerified).toBe(false);
  expect(readBudgets).toEqual([200, 150]);
  expect(timer.getSleepHistory()).toEqual([50, 150]);
  expect(timer.now()).toBe(200);
});

test("accepts a confirming hierarchy read that completes at the verification deadline", async () => {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const chooser = chooserPage([{ ...row("android", 100), node: [{ text: "Example" }] }], 100);
  const readBudgets: number[] = [];
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor, timeoutMs) => {
        if (floor < 1000) {
          return { ...chooser, updatedAt: floor } as any;
        }
        readBudgets.push(timeoutMs ?? 0);
        await timer.sleep(timeoutMs ?? 0);
        return { hierarchy: { node: {} }, packageName: target, updatedAt: floor } as any;
      },
    },
    timer,
  );
  const result = await manager.handleIntentChooser(chooser as any, "custom", target);
  expect(result.success).toBe(true);
  expect(result.packageVerified).toBe(false);
  expect(readBudgets).toEqual([200]);
  expect(timer.now()).toBe(200);
});

test("returns the typed verification failure when a bounded hierarchy read rejects", async () => {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const chooser = chooserPage([{ ...row("android", 100), node: [{ text: "Example" }] }], 100);
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor, timeoutMs) => {
        if (floor < 1000) {
          return { ...chooser, updatedAt: floor } as any;
        }
        await timer.sleep(timeoutMs ?? 11_000);
        throw new Error("capture timed out");
      },
    },
    timer,
  );
  const result = await manager.handleIntentChooser(chooser as any, "custom", target);
  expect(result.success).toBe(false);
  expect(result.error).toContain("Unverified chooser selection");
  expect(result.packageVerified).toBe(false);
  expect(timer.now()).toBe(200);
});

test("accepts a fresh target capture within the tap's device-second", async () => {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  adb.setDeviceTimestampSource("device-seconds");
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const chooser = chooserPage([{ ...row("android", 100), node: [{ text: "Example" }] }], 100);
  const floors: number[] = [];
  let postTapReads = 0;
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor) => {
        floors.push(floor);
        if (floor < 2000) {
          return { ...chooser, updatedAt: floor } as any;
        }
        postTapReads += 1;
        return postTapReads === 1
          ? ({ ...chooser, updatedAt: 1000 } as any)
          : ({ hierarchy: { node: {} }, packageName: target, updatedAt: 1000 } as any);
      },
    },
    timer,
  );
  const result = await manager.handleIntentChooser(chooser as any, "custom", target);
  expect(result.success).toBe(true);
  // openLink compares against this raw second, not the internal 2000ms floor.
  expect(result.tappedAt).toBe(1000);
  expect(floors).toEqual([101, 102, 2000, 2000]);
  expect(timer.getSleepHistory()).toEqual([50]);
});

test("rejects an out-of-order target capture after a newer device-seconds observation", async () => {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  adb.setDeviceTimestampSource("device-seconds");
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const chooser = chooserPage([{ ...row("android", 100), node: [{ text: "Example" }] }], 100);
  const floors: number[] = [];
  let postTapReads = 0;
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor) => {
        floors.push(floor);
        if (floor < 2000) {
          return { ...chooser, updatedAt: floor } as any;
        }
        postTapReads += 1;
        if (postTapReads === 1) {
          return { hierarchy: { node: {} }, packageName: "com.other.app", updatedAt: 2500 } as any;
        }
        if (postTapReads === 2) {
          return { hierarchy: { node: {} }, packageName: target, updatedAt: 1600 } as any;
        }
        return { hierarchy: { node: {} }, packageName: "com.other.app", updatedAt: 2500 } as any;
      },
    },
    timer,
  );
  const result = await manager.handleIntentChooser(chooser as any, "custom", target);
  expect(result.success).toBe(false);
  expect(result.packageVerified).toBe(false);
  expect(result.error).toContain("Unverified chooser selection");
  expect(floors.slice(0, 4)).toEqual([101, 102, 2000, 2501]);
  expect(postTapReads).toBe(4);
  expect(timer.now()).toBe(200);
});

test("rejects a millisecond-clock target capture older than the moving floor", async () => {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const chooser = chooserPage([{ ...row("android", 100), node: [{ text: "Example" }] }], 100);
  const floors: number[] = [];
  let postTapReads = 0;
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor) => {
        floors.push(floor);
        if (floor < 1000) {
          return { ...chooser, updatedAt: floor } as any;
        }
        postTapReads += 1;
        if (postTapReads === 1) {
          return { hierarchy: { node: {} }, packageName: "com.other.app", updatedAt: 2500 } as any;
        }
        if (postTapReads === 2) {
          return { hierarchy: { node: {} }, packageName: target, updatedAt: 1600 } as any;
        }
        return { hierarchy: { node: {} }, packageName: "com.other.app", updatedAt: floor } as any;
      },
    },
    timer,
  );
  const result = await manager.handleIntentChooser(chooser as any, "custom", target);
  expect(result.success).toBe(false);
  expect(result.packageVerified).toBe(false);
  expect(result.error).toContain("Unverified chooser selection");
  expect(floors.slice(0, 4)).toEqual([101, 102, 1000, 2501]);
  expect(postTapReads).toBe(4);
});

test("accepts a target app screen containing chooser button text and IDs", async () => {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  const chooser = chooserPage([{ ...row("android", 100), node: [{ text: "Example" }] }], 100);
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor) =>
        floor < 1000
          ? ({ ...chooser, updatedAt: floor } as any)
          : ({
              hierarchy: {
                node: {
                  node: [
                    { text: "Open with" },
                    { text: "Always" },
                    { text: "Just once", "resource-id": "android:id/button_once" },
                  ],
                },
              },
              packageName: target,
              updatedAt: floor,
            } as any),
    },
  );
  const result = await manager.handleIntentChooser(chooser as any, "custom", target);
  expect(result.success).toBe(true);
  expect(result.packageVerified).toBe(false);
});

test("deduplicates a stable chooser row visible in overlapping captures", async () => {
  const adb = new FakeAdbExecutor();
  const stableRow = (top: number) => ({ ...row(target, top), "view-id": "s2-0123456789abcdef" });
  const anchor = (top: number) => ({
    ...row("com.other.app", top),
    "view-id": "s2-aaaaaaaaaaaaaaaa",
  });
  const first = chooserPage([anchor(100), stableRow(140)], 100);
  const second = chooserPage([anchor(0), stableRow(40)], 101);
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => null,
      getFreshHierarchy: async (_device, _factory, floor) =>
        ({ ...second, updatedAt: floor }) as any,
    },
  );
  const result = await manager.handleIntentChooser(first as any, "custom", target);
  expect(result.success).toBe(true);
  expect(adb.getExecutedCommands().at(-1)).toBe("shell input tap 50 60");
});

test("deduplicates a clamped chooser scroll using another row's observed displacement", async () => {
  const adb = new FakeAdbExecutor();
  const stableRow = (packageName: string, top: number, id: string) => ({
    ...row(packageName, top),
    "view-id": id,
  });
  const first = chooserPage(
    [
      stableRow("com.other.app", 80, "s2-aaaaaaaaaaaaaaaa"),
      stableRow(target, 140, "s2-bbbbbbbbbbbbbbbb"),
    ],
    100,
  );
  const second = chooserPage(
    [
      stableRow("com.other.app", 40, "s2-aaaaaaaaaaaaaaaa"),
      stableRow(target, 100, "s2-bbbbbbbbbbbbbbbb"),
    ],
    101,
  );
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => null,
      getFreshHierarchy: async (_device, _factory, floor) =>
        ({ ...second, updatedAt: floor }) as any,
    },
  );
  const result = await manager.handleIntentChooser(first as any, "custom", target);
  expect(result.success).toBe(true);
  expect(adb.getExecutedCommands()[0]).toBe("shell input swipe 50 150 50 50 350");
  expect(adb.getExecutedCommands().at(-1)).toBe("shell input tap 50 120");
});

test("keeps a repeated chooser target ambiguous when anchor deltas disagree", async () => {
  const adb = new FakeAdbExecutor();
  const stableRow = (packageName: string, top: number, id: string) => ({
    ...row(packageName, top),
    "view-id": id,
  });
  const first = chooserPage(
    [
      stableRow("com.other.one", 60, "s2-aaaaaaaaaaaaaaaa"),
      stableRow(target, 120, "s2-bbbbbbbbbbbbbbbb"),
      stableRow("com.other.two", 180, "s2-cccccccccccccccc"),
    ],
    100,
  );
  const second = chooserPage(
    [
      stableRow("com.other.one", 20, "s2-aaaaaaaaaaaaaaaa"),
      stableRow(target, 55, "s2-bbbbbbbbbbbbbbbb"),
      stableRow("com.other.two", 90, "s2-cccccccccccccccc"),
    ],
    101,
  );
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => null,
      getFreshHierarchy: async (_device, _factory, floor) =>
        ({ ...second, updatedAt: floor }) as any,
    },
  );
  const result = await manager.handleIntentChooser(first as any, "custom", target);
  expect(
    manager["getObservedChooserDisplacement"](first as any, second as any, "s2-bbbbbbbbbbbbbbbb"),
  ).toBeUndefined();
  expect(result.error).toContain("Ambiguous chooser rows");
  expect(
    adb.getExecutedCommands().filter((command) => command.startsWith("shell input tap")),
  ).toEqual([]);
});

test("excludes duplicate chooser anchor IDs from displacement evidence", () => {
  const anchorId = "s2-aaaaaaaaaaaaaaaa";
  const targetId = "s2-bbbbbbbbbbbbbbbb";
  const stableRow = (packageName: string, top: number, id: string) => ({
    ...row(packageName, top),
    "view-id": id,
  });
  const makePage = (anchorTops: number[], targetTop: number, updatedAt: number) =>
    chooserPage(
      [
        ...anchorTops.map((top) => stableRow("com.other.app", top, anchorId)),
        stableRow(target, targetTop, targetId),
      ],
      updatedAt,
    );
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    new FakeAdbExecutor(),
    null,
    null,
  );
  for (const [beforeTops, afterTops] of [
    [[80, 120], [40]],
    [[80], [40, 80]],
    [[80, 120, 160], [40]],
  ]) {
    const before = makePage(beforeTops, 140, 100);
    const after = makePage(afterTops, 100, 101);
    const duplicated = beforeTops.length > 1 ? before : after;
    expect(manager["getChooserAnchorRows"](duplicated as any).has(anchorId)).toBe(false);
    expect(
      manager["getObservedChooserDisplacement"](before as any, after as any, targetId),
    ).toBeUndefined();
  }
});

test("rejects opposite-direction chooser anchors as scroll evidence", async () => {
  const adb = new FakeAdbExecutor();
  const stableRow = (packageName: string, top: number, id: string) => ({
    ...row(packageName, top),
    "view-id": id,
  });
  const anchorId = "s2-aaaaaaaaaaaaaaaa";
  const targetId = "s2-bbbbbbbbbbbbbbbb";
  const first = chooserPage(
    [stableRow("com.other.app", 20, anchorId), stableRow(target, 140, targetId)],
    100,
  );
  const second = chooserPage(
    [stableRow("com.other.app", 60, anchorId), stableRow(target, 100, targetId)],
    101,
  );
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => null,
      getFreshHierarchy: async (_device, _factory, floor) =>
        ({ ...second, updatedAt: floor }) as any,
    },
  );
  expect(
    manager["getObservedChooserDisplacement"](first as any, second as any, targetId),
  ).toBeUndefined();
  const result = await manager.handleIntentChooser(first as any, "custom", target);
  expect(result.error).toContain("Ambiguous chooser rows");
  expect(adb.getExecutedCommands()[0]).toBe("shell input swipe 50 150 50 50 350");
  expect(
    adb.getExecutedCommands().filter((command) => command.startsWith("shell input tap")),
  ).toEqual([]);
});

test("keeps a repeated stable target ambiguous without overlapping anchor rows", async () => {
  const adb = new FakeAdbExecutor();
  const stableTarget = (top: number) => ({
    ...row(target, top),
    "view-id": "s2-bbbbbbbbbbbbbbbb",
  });
  const first = chooserPage([row("com.other.before", 80), stableTarget(140)], 100);
  const second = chooserPage([row("com.other.after", 40), stableTarget(100)], 101);
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => null,
      getFreshHierarchy: async (_device, _factory, floor) =>
        ({ ...second, updatedAt: floor }) as any,
    },
  );
  const result = await manager.handleIntentChooser(first as any, "custom", target);
  expect(result.error).toContain("Ambiguous chooser rows");
  expect(
    adb.getExecutedCommands().filter((command) => command.startsWith("shell input tap")),
  ).toEqual([]);
});

test("keeps a repeated stable target ambiguous when only its clickable child overlaps", async () => {
  const adb = new FakeAdbExecutor();
  const stableTarget = (top: number) => ({
    ...row(target, top),
    "view-id": "s2-bbbbbbbbbbbbbbbb",
    node: [
      ...row(target, top).node,
      {
        clickable: true,
        "view-id": "s2-cccccccccccccccc",
        text: "Open",
        bounds: { left: 60, top: top + 5, right: 90, bottom: top + 35 },
      },
    ],
  });
  const first = chooserPage([row("com.other.before", 80), stableTarget(140)], 100);
  const second = chooserPage([row("com.other.after", 40), stableTarget(100)], 101);
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => null,
      getFreshHierarchy: async (_device, _factory, floor) =>
        ({ ...second, updatedAt: floor }) as any,
    },
  );
  const result = await manager.handleIntentChooser(first as any, "custom", target);
  expect(result.error).toContain("Ambiguous chooser rows");
  expect(
    manager["getObservedChooserDisplacement"](first as any, second as any, "s2-bbbbbbbbbbbbbbbb"),
  ).toBeUndefined();
  expect(
    adb.getExecutedCommands().filter((command) => command.startsWith("shell input tap")),
  ).toEqual([]);
});

test("rejects identical stable label rows separated by chooser pages without tapping", async () => {
  const adb = new FakeAdbExecutor();
  const stableRow = (top: number) => ({
    ...row("android", top),
    "view-id": "s2-0123456789abcdef",
    node: [{ text: "Example" }],
  });
  const pages = [
    chooserPage([stableRow(140)], 100),
    chooserPage([row("com.other.one", 100)], 101),
    chooserPage([row("com.other.two", 100)], 102),
    chooserPage([stableRow(40), row("com.other.three", 140)], 103),
  ];
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor) => {
        const page = Math.min(
          adb.getExecutedCommands().filter((command) => command.startsWith("shell input swipe"))
            .length,
          pages.length - 1,
        );
        return { ...pages[page], updatedAt: floor } as any;
      },
    },
  );
  const result = await manager.handleIntentChooser(pages[0] as any, "custom", target);
  expect(result.error).toContain("Ambiguous chooser rows");
  expect(
    adb.getExecutedCommands().filter((command) => command.startsWith("shell input tap")),
  ).toEqual([]);
});

test("keeps resource-backed row IDs ambiguous across pages", async () => {
  const adb = new FakeAdbExecutor();
  const recycledRow = (top: number) => ({
    ...row(target, top),
    "resource-id": "android:id/chooser_row",
    "view-id": "android:id/chooser_row",
  });
  const first = chooserPage([recycledRow(0)], 100);
  const second = chooserPage([row("com.other.app", 0), recycledRow(100)], 101);
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => null,
      getFreshHierarchy: async (_device, _factory, floor) =>
        ({ ...second, updatedAt: floor }) as any,
    },
  );
  const result = await manager.handleIntentChooser(first as any, "custom", target);
  expect(result.error).toContain("Ambiguous chooser rows");
  expect(adb.getExecutedCommands().some((command) => command.startsWith("shell input tap"))).toBe(
    false,
  );
});

test("uses the label refresh timestamp as the post-swipe freshness floor", async () => {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  const labelRow = { ...row("android", 100), node: [{ text: "Example" }] };
  const chooser = chooserPage([labelRow], 100);
  const floors: number[] = [];
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor) => {
        floors.push(floor);
        if (floor >= 1000) {
          return { hierarchy: { node: {} }, packageName: target, updatedAt: floor } as any;
        }
        return { ...chooser, updatedAt: floor === 101 ? 101 : floor } as any;
      },
    },
  );
  await manager.handleIntentChooser(chooser as any, "custom", target);
  expect(floors.slice(0, 2)).toEqual([101, 102]);
});

test("restores a clipped middle-page row by rematching each reverse viewport", async () => {
  const adb = new FakeAdbExecutor();
  const stableRow = (top: number) => ({ ...row(target, top), "view-id": "s2-fedcba9876543210" });
  const pages = [
    chooserPage([row("com.other.zero", 100)], 100),
    chooserPage([stableRow(100)], 101),
    chooserPage([row("com.other.two", 100)], 102),
    chooserPage([row("com.other.three", 100)], 103),
    chooserPage([row("com.other.reverse-one", 100)], 104),
    chooserPage([row("com.other.reverse-two", 100)], 105),
    chooserPage([stableRow(140)], 106),
  ];
  let viewport = 0;
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    {
      getLabel: async () => null,
      getFreshHierarchy: async (_device, _factory, floor) => {
        const swipeCount = adb
          .getExecutedCommands()
          .filter((command) => command.startsWith("shell input swipe")).length;
        if (swipeCount > viewport) {
          viewport = swipeCount;
        }
        return { ...pages[viewport], updatedAt: floor } as any;
      },
    },
  );
  const result = await manager.handleIntentChooser(pages[0] as any, "custom", target);
  expect(result.success).toBe(true);
  expect(
    adb.getExecutedCommands().filter((command) => command.startsWith("shell input swipe")).length,
  ).toBe(6);
  expect(adb.getExecutedCommands().at(-1)).toBe("shell input tap 50 160");
});

test("chooser warns and preserves its failure result when hierarchy inspection throws", async () => {
  const manager = new DeepLinkManager(
    { name: "fake", platform: "android", deviceId: "fake" },
    new FakeAdbExecutor(),
  );
  const error = new Error("chooser hierarchy unavailable");
  const inspect = spyOn(manager, "detectIntentChooser").mockImplementation(() => {
    throw error;
  });
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(await manager.handleIntentChooser(hierarchy([]))).toEqual({
      success: false,
      detected: true,
      error: error.message,
      packageVerified: undefined,
    });
    expect(
      loggerCallsWithPrefix(
        warning.mock.calls,
        "[DeepLinkManager] Failed to handle intent chooser:",
      ),
    ).toEqual([
      ["[DeepLinkManager] Failed to handle intent chooser: chooser hierarchy unavailable", error],
    ]);
  } finally {
    inspect.mockRestore();
    warning.mockRestore();
  }
});
