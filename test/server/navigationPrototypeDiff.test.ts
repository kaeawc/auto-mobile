import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { getNavigationGraphResultSchema } from "../../src/server/navigationToolOutputSchemas";
import { registerNavigationTools } from "../../src/server/navigationTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { toolJson } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const APP = "com.example.app";

const spec = {
  id: "demo",
  window: { placement: { type: "fullscreen" } },
  root: {
    type: "stack",
    id: "nav",
    start: "home",
    screens: {
      home: {
        type: "button",
        label: "Open",
        onTap: [{ type: "push", stack: "nav", screen: "detail" }],
      },
      detail: { type: "text", text: "Detail" },
    },
  },
};

let graph: FakeNavigationGraphManager;
let files: FakePrototypeAssetFileReader;

/** The diff, parsed through the tool's own output schema. */
const diffOf = async (args: Record<string, unknown>) =>
  getNavigationGraphResultSchema.parse(toolJson(await call(args))).prototypeDiff;

const call = (args: Record<string, unknown>) =>
  ToolRegistry.getRegisteredTool("getNavigationGraph")!.deviceAwareHandler!(device, {
    platform: "android",
    appId: APP,
    ...args,
  });

describe("getNavigationGraph prototype diff (#14125)", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    graph = new FakeNavigationGraphManager();
    graph.setCurrentAppId(APP);
    for (const screenName of ["HomeScreen", "DetailScreen", "CartScreen"]) {
      graph.addNode({ screenName, firstSeenAt: 1, lastSeenAt: 1, visitCount: 1 });
    }
    graph.addEdge({ from: "HomeScreen", to: "DetailScreen", timestamp: 2, edgeType: "tool" });
    files = new FakePrototypeAssetFileReader();
    registerNavigationTools({
      navigationManagerFactory: () => graph,
      prototypeFileReader: files,
    });
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("returns no prototypeDiff without a prototype spec", async () => {
    expect(await diffOf({})).toBeUndefined();
  });

  test("diffs an inline spec against the app's graph", async () => {
    const diff = await diffOf({ prototypeSpec: spec });
    expect(diff?.matched.map((m) => m.real)).toEqual(["HomeScreen", "DetailScreen"]);
    expect(diff?.unmatchedRealScreens).toEqual(["CartScreen"]);
    expect(diff?.observedTransitions).toHaveLength(1);
  });

  test("reads the spec and the mapping from files", async () => {
    files.addFile("/work/spec.json", Buffer.from(JSON.stringify(spec)));
    files.addFile(
      "/work/map.json",
      Buffer.from(JSON.stringify({ "stack:nav/detail": "CartScreen" })),
    );
    const diff = await diffOf({
      prototypeSpecPath: "/work/spec.json",
      screenMappingPath: "/work/map.json",
    });
    expect(diff?.matched).toContainEqual({
      prototype: "stack:nav/detail",
      real: "CartScreen",
      by: "mapping",
    });
    expect(files.reads).toEqual(["/work/spec.json", "/work/map.json"]);
  });

  test.each([
    [{ prototypeSpec: spec, prototypeSpecPath: "/work/spec.json" }, "not both"],
    [{ prototypeSpec: spec, screenMapping: {}, screenMappingPath: "/work/m.json" }, "not both"],
    [{ screenMapping: { root: "HomeScreen" } }, "needs prototypeSpec"],
    [{ prototypeSpec: { id: "bad" } }, "prototype spec is invalid"],
    [{ prototypeSpecPath: "relative.json" }, "path must be absolute"],
  ])("refuses %o", async (args, message) => {
    await expect(call(args)).rejects.toThrow(message);
  });

  test("refuses a mapping file that is not an object of strings", async () => {
    files.addFile("/work/map.json", Buffer.from(JSON.stringify({ root: 1 })));
    await expect(
      call({ prototypeSpec: spec, screenMappingPath: "/work/map.json" }),
    ).rejects.toThrow("expected a JSON object");
  });
});
