import { describe, expect, test } from "bun:test";
import { DeepLinkManager, type ChooserAppMetadata } from "../../src/utils/DeepLinkManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

const metadata = (
  label: string | null,
  nodes: unknown[],
  packageName?: string,
  listId?: string,
): ChooserAppMetadata => ({
  getLabel: async () => label,
  getFreshHierarchy: async (_device, _factory, minTimestamp) =>
    ({
      ...hierarchy(nodes, listId),
      packageName: minTimestamp > 101 ? target : packageName,
      updatedAt: Math.max(101, minTimestamp),
      hierarchy: minTimestamp > 101 ? { node: {} } : hierarchy(nodes, listId).hierarchy,
    }) as any,
});

const target = "com.example.app";
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

async function choose(nodes: unknown[], label: string | null = null, listId?: string) {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    metadata(label, nodes, undefined, listId),
  );
  const result = await manager.handleIntentChooser(
    hierarchy(nodes, listId) as any,
    "custom",
    target,
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
  // #7724: Pending intent-label plumbing from HandleIntentChooser into DeepLinkManager.
  test.skip("uses the resolved activity label when it differs from the application label", async () => {
    const { result } = await choose([labelRow("Activity Name", 100)], "Application Name");
    expect(result.success).toBe(true);
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
    expect(result.tappedAt).toBe(2000);
    expect(floors).toEqual([101, 2000]);
  });
  test("does not claim a shared-label row selected the requested package", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDeviceTimestampMs(1000);
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
