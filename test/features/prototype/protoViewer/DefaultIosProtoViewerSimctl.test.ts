import { expect, test } from "bun:test";
import { DefaultIosProtoViewerSimctl } from "../../../../src/features/prototype/protoViewer/DefaultIosProtoViewerSimctl";
import type { ExecResult } from "../../../../src/models";
import type { IosInstalledAppRecord } from "../../../../src/utils/ios-cmdline-tools/iosInstalledApp";

const STORE = "dev.jasonpearson.automobile.protoviewer" as const;
const DEV = `${STORE}.dev`;
const UDID = "00000000-0000-0000-0000-000000000001";

class FakeSimctl {
  readonly calls: string[][] = [];
  constructor(private readonly apps: IosInstalledAppRecord[]) {}
  async listAppsOrThrow(): Promise<IosInstalledAppRecord[]> {
    return this.apps;
  }
  async executeCommandArgs(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    return { stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false };
  }
}

async function launchedBundle(
  apps: IosInstalledAppRecord[],
  candidates?: readonly (typeof STORE)[],
): Promise<string | undefined> {
  const client = new FakeSimctl(apps);
  const simctl = new DefaultIosProtoViewerSimctl(client, candidates);
  if (!(await simctl.installed(UDID))) {
    return undefined;
  }
  await simctl.launch(UDID, 1000);
  expect(await simctl.dataContainer(UDID)).toBe("");
  const containerBundle = client.calls.find((args) => args[0] === "get_app_container")?.[2];
  const launched = client.calls.find((args) => args[0] === "launch")?.[2];
  expect(containerBundle).toBe(launched);
  return launched;
}

test("drives the store build when it is the only one installed", async () => {
  expect(await launchedBundle([{ bundleId: STORE }])).toBe(STORE);
});

test("drives the .dev build when it is the only one installed", async () => {
  expect(await launchedBundle([{ bundleId: DEV }])).toBe(DEV);
});

test("prefers the .dev build when both are installed", async () => {
  expect(await launchedBundle([{ bundleId: STORE }, { bundleId: DEV }])).toBe(DEV);
});

test("is not installed when neither build is present", async () => {
  expect(
    await launchedBundle([{ bundleId: "dev.jasonpearson.automobile.prototype-viewer" }]),
  ).toBeUndefined();
});

test("a caller pinned to the store build ignores a .dev build", async () => {
  expect(await launchedBundle([{ bundleId: DEV }, { bundleId: STORE }], [STORE])).toBe(STORE);
  expect(await launchedBundle([{ bundleId: DEV }], [STORE])).toBeUndefined();
});
