import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerOverlayTools, overlayOutputSchema } from "../../src/server/overlayTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { MAX_OVERLAY_SPEC_BYTES } from "../../src/features/overlay/overlaySpec";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeOverlayAssetFileReader } from "../fakes/FakeOverlayAssetFileReader";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "fake-overlay", platform: "android", name: "Fake" };
const spec = {
  id: "from-file",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "text" as const, text: "Hello" },
};
const file = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("prototype show specPath", () => {
  let client: FakeCtrlProxy;
  let reader: FakeOverlayAssetFileReader;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    reader = new FakeOverlayAssetFileReader().addFile("/work/spec.json", file(spec));
    unsubscribe = registerOverlayTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      assetFileReader: reader,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: unknown) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return { response, payload: overlayOutputSchema.parse(response.structuredContent) };
  }
  async function refusal(input: unknown): Promise<string> {
    const { response, payload } = await call(input);
    expect(response.isError).toBe(true);
    expect(client.getOverlayHistory()).toEqual([]);
    return payload.error ?? "";
  }

  test("shows the spec read from the file and never sends the path to the device", async () => {
    const { response } = await call({ action: "show", specPath: "/work/spec.json" });
    expect(response.isError).not.toBe(true);
    const history = client.getOverlayHistory();
    expect(history).toHaveLength(1);
    expect(JSON.stringify(history)).toContain("from-file");
    expect(JSON.stringify(history)).not.toContain("/work/spec.json");
    expect(reader.reads).toEqual(["/work/spec.json"]);
  });

  test("a spec file with components is sent expanded (#11053)", async () => {
    reader.addFile(
      "/work/components.json",
      file({
        ...spec,
        components: { hello: { root: { type: "text", text: "Hello {props.name}" } } },
        root: { type: "use", component: "hello", props: { name: "file" } },
      }),
    );
    const { response } = await call({ action: "show", specPath: "/work/components.json" });
    expect(response.isError).not.toBe(true);
    expect(client.getOverlayHistory()).toMatchObject([
      { method: "show", spec: { ...spec, root: { type: "text", text: "Hello file" } } },
    ]);
    expect(JSON.stringify(client.getOverlayHistory())).not.toContain("components");
  });

  test("other show options still apply", async () => {
    await call({ action: "show", specPath: "/work/spec.json" });
    const { response } = await call({ action: "show", specPath: "/work/spec.json", reset: true });
    expect(response.isError).not.toBe(true);
    expect(client.getOverlayHistory()).toHaveLength(2);
  });

  test("a missing file names the file", async () => {
    const error = await refusal({ action: "show", specPath: "/work/missing.json" });
    expect(error).toContain("specPath /work/missing.json: cannot read file");
  });

  test("a relative path is refused without reading", async () => {
    const error = await refusal({ action: "show", specPath: "spec.json" });
    expect(error).toContain("specPath spec.json: path must be absolute");
    expect(reader.reads).toEqual([]);
  });

  test("a directory is refused", async () => {
    reader.addDirectory("/work");
    expect(await refusal({ action: "show", specPath: "/work" })).toContain("not a regular file");
  });

  test("invalid JSON names the file", async () => {
    reader.addFile("/work/bad.json", Buffer.from("{ not json"));
    const error = await refusal({ action: "show", specPath: "/work/bad.json" });
    expect(error).toContain("specPath /work/bad.json: invalid JSON");
  });

  test("an oversize file is refused from its size, before it is read", async () => {
    reader.addFile("/work/big.json", Buffer.alloc(MAX_OVERLAY_SPEC_BYTES + 1, 0x20));
    const error = await refusal({ action: "show", specPath: "/work/big.json" });
    expect(error).toContain(`specPath /work/big.json: file is ${MAX_OVERLAY_SPEC_BYTES + 1} bytes`);
    expect(reader.reads).toEqual([]);
  });

  test("a validation error names the file and the JSON path", async () => {
    const bad = {
      ...spec,
      root: {
        type: "column",
        children: [
          { type: "text", text: "x" },
          { type: "spacer", axis: 1 },
        ],
      },
    };
    reader.addFile("/work/invalid.json", file(bad));
    const error = await refusal({ action: "show", specPath: "/work/invalid.json" });
    expect(error).toStartWith("specPath /work/invalid.json: root.children[1]");
  });

  test("giving both spec and specPath is refused", async () => {
    const error = await refusal({ action: "show", spec, specPath: "/work/spec.json" });
    expect(error).toContain("either spec or specPath, not both");
  });

  test("giving neither is refused", async () => {
    expect(await refusal({ action: "show" })).toContain("exactly one of spec or specPath");
  });

  test("specPath is a show-only field", async () => {
    const { response, payload } = await call({ action: "dismiss", all: true, specPath: "/x.json" });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain("dismiss allows");
  });
});
