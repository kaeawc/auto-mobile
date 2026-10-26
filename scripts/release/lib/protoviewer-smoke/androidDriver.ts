import type { BootedDevice } from "../../../../src/models";
import { parseStringPromise } from "xml2js";
import { AndroidProtoViewer } from "../../../../src/features/prototype/protoViewer/AndroidProtoViewer";
import { NodeProtoViewerTempFiles } from "../../../../src/features/prototype/protoViewer/NodeProtoViewerTempFiles";
import { PROTOVIEWER_PACKAGE } from "../../../../src/features/prototype/protoViewer/protoViewerContract";
import { defaultAdbClientFactory } from "../../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { defaultIdGenerator } from "../../../../src/utils/IdGenerator";
import { defaultTimer } from "../../../../src/utils/SystemTimer";
import type { ToolRunner } from "../artifact-policy/toolRunner";
import type { InstalledApp, ScreenDriver, SmokeDriver } from "./flows";

const DUMP_PATH = "/sdcard/protoviewer-smoke-window.xml";

interface UiNode {
  readonly text: string;
  readonly bounds: string;
}

/** Depth-first walk of a uiautomator dump; text lives in node attributes, never in markup text. */
export function collectUiNodes(root: unknown): UiNode[] {
  const nodes: UiNode[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const attrs = record.$ as Record<string, string> | undefined;
    const label = attrs?.text || attrs?.["content-desc"];
    if (attrs && label) nodes.push({ text: label, bounds: attrs.bounds ?? "" });
    const children = record.node;
    if (Array.isArray(children)) children.forEach(visit);
    if (record.hierarchy) visit(record.hierarchy);
  };
  visit(root);
  return nodes;
}

export function boundsCenter(bounds: string): { x: number; y: number } | undefined {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(bounds);
  if (!match) return undefined;
  const [left, top, right, bottom] = match.slice(1).map(Number) as [number, number, number, number];
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

export function parseInstalledApp(dumpsys: string): InstalledApp {
  const version = /versionCode=(\d+)/.exec(dumpsys)?.[1];
  const firstInstall = /firstInstallTime=(.+)/.exec(dumpsys)?.[1]?.trim();
  if (version === undefined || firstInstall === undefined) {
    throw new Error(`${PROTOVIEWER_PACKAGE} is not installed or dumpsys output was not recognised`);
  }
  return { version, dataIdentity: firstInstall };
}

class AndroidScreens implements ScreenDriver {
  constructor(private readonly adb: (args: readonly string[]) => Promise<string>) {}

  async launchLibrary(): Promise<void> {
    await this.adb(["shell", "am", "force-stop", PROTOVIEWER_PACKAGE]);
    await this.adb(["shell", "am", "start", "-W", "-n", `${PROTOVIEWER_PACKAGE}/.LibraryActivity`]);
  }

  private async nodes(): Promise<UiNode[]> {
    await this.adb(["shell", "uiautomator", "dump", DUMP_PATH]);
    const xml = await this.adb(["shell", "cat", DUMP_PATH]);
    return collectUiNodes(await parseStringPromise(xml));
  }

  async visibleText(): Promise<readonly string[]> {
    return (await this.nodes()).map((node) => node.text);
  }

  async tapText(text: string): Promise<boolean> {
    const node = (await this.nodes()).find((candidate) => candidate.text === text);
    const center = node ? boundsCenter(node.bounds) : undefined;
    if (!center) return false;
    await this.adb(["shell", "input", "tap", String(center.x), String(center.y)]);
    return true;
  }
}

export function createAndroidDriver(serial: string, runner: ToolRunner): SmokeDriver {
  const adb = async (args: readonly string[]): Promise<string> =>
    (await runner.run("adb", ["-s", serial, ...args])).stdout;
  const device: BootedDevice = { name: serial, platform: "android", deviceId: serial };
  return {
    platform: "android",
    async install(artifact) {
      // -r keeps app data; an uninstall here would hide exactly the bug this run looks for.
      await adb(["install", "-r", artifact]);
    },
    async installedApp() {
      return parseInstalledApp(await adb(["shell", "dumpsys", "package", PROTOVIEWER_PACKAGE]));
    },
    viewer: new AndroidProtoViewer({
      adb: defaultAdbClientFactory.create(device),
      timer: defaultTimer,
      ids: defaultIdGenerator,
      tempFiles: new NodeProtoViewerTempFiles(),
    }),
    screens: new AndroidScreens(adb),
  };
}
