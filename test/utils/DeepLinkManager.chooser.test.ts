import { describe, expect, test } from "bun:test";
import { DeepLinkManager, type ChooserAppMetadata } from "../../src/utils/DeepLinkManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

const metadata = (label: string | null): ChooserAppMetadata => ({ getLabel: async () => label });

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
const hierarchy = (nodes: unknown[]) => ({
  hierarchy: { node: { class: "com.android.internal.app.ChooserActivity", node: nodes } },
});

async function choose(nodes: unknown[], label: string | null = null) {
  const adb = new FakeAdbExecutor();
  const manager = new DeepLinkManager(
    { platform: "android", deviceId: "fake", name: "fake" },
    adb,
    null,
    null,
    undefined,
    undefined,
    metadata(label),
  );
  const result = await manager.handleIntentChooser(hierarchy(nodes) as any, "custom", target);
  return { result, commands: adb.getExecutedCommands() };
}

describe("custom intent chooser exact package selection", () => {
  for (const reverse of [false, true]) {
    test(`selects exact package and taps clickable row (reverse=${reverse})`, async () => {
      const rows = [row(`${target}.beta`, 0), row(target, 100)];
      const { result, commands } = await choose(reverse ? rows.reverse() : rows);
      expect(result.success).toBe(true);
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
  test("matches the resolved label exactly and promotes its row", async () => {
    const { result, commands } = await choose(
      [labelRow("Example Beta", 0), labelRow("Example", 100)],
      "Example",
    );
    expect(result.success).toBe(true);
    expect(commands).toEqual(["shell input tap 50 120"]);
  });
  test("does not fall back to label when rows carry package metadata", async () => {
    const { result, commands } = await choose(
      [row(`${target}.beta`, 0), labelRow("Example", 100)],
      "Example",
    );
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
      hierarchy: {
        node: [
          { class: "com.android.internal.app.ChooserActivity", node: [row(target, 0)] },
          { node: [row(target, 100)] },
        ],
      },
    } as any,
    "custom",
    target,
  );
  expect(result.error).toContain("Ambiguous");
  expect(adb.getExecutedCommands()).toEqual([]);
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
