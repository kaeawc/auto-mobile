import { describe, expect, test } from "bun:test";
import {
  PROTOVIEWER_IMPORTED_WARNING,
  protoViewerHandles,
  routeToProtoViewer,
} from "../../../../src/features/prototype/protoViewer/protoViewerSaved";
import type { ProtoViewerDevice } from "../../../../src/features/prototype/protoViewer/AndroidProtoViewer";
import type { ProtoViewerResult } from "../../../../src/features/prototype/protoViewer/protoViewerContract";
import { readPrototypeBundle } from "../../../../src/features/prototype/prototypeBundle";
import type { PrototypeSpec } from "../../../../src/features/prototype/prototypeSpec";
import { FakePrototypeAssetFileReader } from "../../../fakes/FakePrototypeAssetFileReader";

const LIBRARY_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const spec = {
  id: "demo",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Hello" },
} as PrototypeSpec;
// A complete 1x1 PNG, so the bundle's signature and type checks accept it.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

class FakeProtoViewerDevice implements ProtoViewerDevice {
  user: number | undefined = 0;
  importResult: ProtoViewerResult | Error = {
    status: "imported",
    request: "r",
    libraryId: LIBRARY_ID,
    label: "Demo",
  };
  openResult: ProtoViewerResult | Error = {
    status: "opened",
    request: "r",
    libraryId: LIBRARY_ID,
    label: "Demo",
  };
  readonly imports: Array<{ userId: number; bytes: Uint8Array; label?: string }> = [];
  readonly opens: Array<{ userId: number; libraryId: string }> = [];
  async installedUser(): Promise<number | undefined> {
    return this.user;
  }
  async importBundle(
    userId: number,
    bytes: Uint8Array,
    label: string | undefined,
  ): Promise<ProtoViewerResult> {
    this.imports.push({ userId, bytes, label });
    if (this.importResult instanceof Error) {
      throw this.importResult;
    }
    return this.importResult;
  }
  async open(userId: number, libraryId: string): Promise<ProtoViewerResult> {
    this.opens.push({ userId, libraryId });
    if (this.openResult instanceof Error) {
      throw this.openResult;
    }
    return this.openResult;
  }
}

function deps(device: FakeProtoViewerDevice, files: Record<string, Buffer> = {}) {
  const reader = new FakePrototypeAssetFileReader();
  for (const [path, bytes] of Object.entries(files)) {
    reader.addFile(path, bytes);
  }
  return {
    device,
    assetFileReader: reader,
    observationScreenshotReader: async () => {
      throw new Error("no observations in this test");
    },
  };
}

describe("ProtoViewer routing decision", () => {
  test("save without pin or icon, and open, route to ProtoViewer", () => {
    expect(protoViewerHandles({ action: "save" })).toBe(true);
    expect(protoViewerHandles({ action: "open" })).toBe(true);
  });

  test("pin and icon stay on CtrlProxy: ProtoViewer has no launcher shortcuts", () => {
    expect(protoViewerHandles({ action: "save", pin: true })).toBe(false);
    expect(protoViewerHandles({ action: "save", icon: "logo" })).toBe(false);
  });

  test("show and the other saved actions keep today's path", () => {
    for (const action of ["show", "listSaved", "deleteSaved", "dismiss"]) {
      expect(protoViewerHandles({ action })).toBe(false);
    }
  });
});

describe("save through ProtoViewer", () => {
  test("pushes a canonical bundle with the label and reports the viewer entry", async () => {
    const device = new FakeProtoViewerDevice();
    const output = await routeToProtoViewer(
      { action: "save", spec, label: "Demo", timeoutMs: 5000 },
      deps(device),
    );
    expect(output).toEqual({
      success: true,
      viewer: { app: "protoviewer", libraryId: LIBRARY_ID, label: "Demo" },
      warning: PROTOVIEWER_IMPORTED_WARNING,
    });
    expect(device.imports).toHaveLength(1);
    expect(device.imports[0].label).toBe("Demo");
    const read = readPrototypeBundle(device.imports[0].bytes);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(JSON.parse(Buffer.from(read.bundle.spec).toString("utf8"))).toEqual(spec);
    }
  });

  test("never sends a source: the app decides it", async () => {
    const device = new FakeProtoViewerDevice();
    await routeToProtoViewer({ action: "save", spec }, deps(device));
    const read = readPrototypeBundle(device.imports[0].bytes);
    expect(read.ok && JSON.stringify(read.bundle)).not.toContain("source");
    expect(device.imports[0].label).toBeUndefined();
  });

  test("carries referenced image assets inside the bundle", async () => {
    const device = new FakeProtoViewerDevice();
    const withImage = {
      ...spec,
      root: { type: "image", asset: "logo" },
    } as PrototypeSpec;
    const output = await routeToProtoViewer(
      { action: "save", spec: withImage, assets: [{ id: "logo", path: "/img/logo.png" }] },
      deps(device, { "/img/logo.png": png }),
    );
    expect(output?.success).toBe(true);
    const read = readPrototypeBundle(device.imports[0].bytes);
    expect(read.ok && [...read.bundle.assets.keys()]).toEqual(["logo"]);
  });

  test("a referenced asset that was not uploaded fails before anything reaches the device", async () => {
    const device = new FakeProtoViewerDevice();
    const withImage = {
      ...spec,
      root: { type: "image", asset: "logo" },
    } as PrototypeSpec;
    const output = await routeToProtoViewer({ action: "save", spec: withImage }, deps(device));
    expect(output).toMatchObject({ success: false, errorCode: "missing_asset" });
    expect(device.imports).toHaveLength(0);
  });

  test("falls back to the CtrlProxy path when ProtoViewer is not installed", async () => {
    const device = new FakeProtoViewerDevice();
    device.user = undefined;
    expect(await routeToProtoViewer({ action: "save", spec }, deps(device))).toBeUndefined();
    expect(device.imports).toHaveLength(0);
  });

  test("element anchors are refused like any saved prototype", async () => {
    const device = new FakeProtoViewerDevice();
    const anchored = {
      ...spec,
      root: {
        type: "box",
        anchor: { type: "element", selector: { text: "Buy" }, alignment: "cover" },
        children: [],
      },
    } as PrototypeSpec;
    const output = await routeToProtoViewer({ action: "save", spec: anchored }, deps(device));
    expect(output).toMatchObject({ success: false, errorCode: "invalid_spec" });
    expect(device.imports).toHaveLength(0);
  });

  test("an app rejection names the spec path and reason", async () => {
    const device = new FakeProtoViewerDevice();
    device.importResult = {
      status: "rejected",
      request: "r",
      path: "spec.json:/root/onTap/0/via",
      reason: "via host is not allowed for library prototypes",
    };
    const output = await routeToProtoViewer({ action: "save", spec }, deps(device));
    expect(output).toMatchObject({ success: false, errorCode: "invalid_spec" });
    expect(output?.error).toContain("spec.json:/root/onTap/0/via");
    expect(output?.error).toContain("via host is not allowed");
  });

  test("a device failure is reported, not thrown", async () => {
    const device = new FakeProtoViewerDevice();
    device.importResult = new Error("ProtoViewer did not answer within 5000 ms");
    const output = await routeToProtoViewer({ action: "save", spec }, deps(device));
    expect(output).toMatchObject({ success: false });
    expect(output?.error).toContain("did not answer");
  });
});

describe("open through ProtoViewer", () => {
  test("launches the library id and warns that the entry is imported", async () => {
    const device = new FakeProtoViewerDevice();
    const output = await routeToProtoViewer({ action: "open", id: LIBRARY_ID }, deps(device));
    expect(device.opens).toEqual([{ userId: 0, libraryId: LIBRARY_ID }]);
    expect(output).toEqual({
      success: true,
      viewer: { app: "protoviewer", libraryId: LIBRARY_ID, label: "Demo" },
      warning: PROTOVIEWER_IMPORTED_WARNING,
    });
  });

  test("an unknown library id is not_found", async () => {
    const device = new FakeProtoViewerDevice();
    device.openResult = { status: "not_found", request: "r" };
    const output = await routeToProtoViewer({ action: "open", id: LIBRARY_ID }, deps(device));
    expect(output).toMatchObject({ success: false, errorCode: "not_found" });
  });

  test("an id that is not a library id is refused without a device call", async () => {
    const device = new FakeProtoViewerDevice();
    const output = await routeToProtoViewer({ action: "open", id: "demo" }, deps(device));
    expect(output).toMatchObject({ success: false, errorCode: "invalid_id" });
    expect(device.opens).toHaveLength(0);
  });

  test("open needs ProtoViewer installed", async () => {
    const device = new FakeProtoViewerDevice();
    device.user = undefined;
    const output = await routeToProtoViewer({ action: "open", id: LIBRARY_ID }, deps(device));
    expect(output).toMatchObject({ success: false, errorCode: "unsupported_capability" });
    expect(output?.error).toContain("ProtoViewer");
  });
});
