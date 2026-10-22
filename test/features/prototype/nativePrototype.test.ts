import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  prototypeHostTypeName,
  readNativePrototype,
  readNativePrototypeAsset,
  type NativePrototypePlatform,
  type NativePrototypeSources,
} from "../../../src/features/prototype/nativePrototype";
import {
  renderComposeHostFile,
  renderSwiftUiHostFile,
  type HostFileInput,
} from "../../../src/features/prototype/nativePrototypeTemplates";
import { PrototypeShownSpecs } from "../../../src/features/prototype/PrototypeShownSpecs";
import type { MirroredSavedPrototype } from "../../../src/features/prototype/savedPrototypeMirror";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";

const REPO = path.join(import.meta.dir, "../../..");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const checkout = {
  id: "checkout",
  window: { placement: { type: "fullscreen" } },
  state: { status: "idle" },
  data: { asset: "not-a-reference" },
  storage: { version: 1, keys: ["state:status"] },
  root: {
    type: "column",
    style: { fontFamily: { asset: "brand" } },
    children: [
      { type: "image", asset: "hero" },
      {
        type: "button",
        label: "Pay",
        onTap: [{ type: "request", url: "https://example.test/pay", statusKey: "status" }],
      },
    ],
  },
};

interface FakeOptions {
  shown?: Record<string, Record<string, unknown>>;
  saved?: Record<string, MirroredSavedPrototype[]>;
  platforms?: Record<string, NativePrototypePlatform>;
}

function sources(options: FakeOptions = {}): NativePrototypeSources {
  const specs = new PrototypeShownSpecs();
  for (const [deviceId, spec] of Object.entries(options.shown ?? {})) {
    const ticket = specs.beginShow(deviceId, String(spec.id));
    specs.endShow(deviceId, ticket, { id: String(spec.id), spec, replaceOthers: false });
  }
  return {
    shownSpec: (deviceId, id) => specs.read(deviceId, id),
    devicesShowing: (id) => specs.devicesShowing(id),
    savedPrototypes: async (deviceId) => options.saved?.[deviceId] ?? [],
    platformOf: async (deviceId) => options.platforms?.[deviceId],
    libraryVersion: () => "0.0.88",
  };
}

function savedCheckout(): MirroredSavedPrototype {
  return {
    id: "checkout",
    spec: prototypeSpecSchema.parse(checkout),
    label: "Checkout",
    assets: [{ id: "hero", mimeType: "image/png", bytes: PNG }, { id: "brand" }],
  };
}

describe("automobile:prototype/native", () => {
  test("Android output pins the Compose artifact and bundles spec, host file and assets", async () => {
    const native = await readNativePrototype(
      { id: "checkout" },
      sources({ shown: { "emulator-5554": checkout }, platforms: { "emulator-5554": "android" } }),
    );
    expect(native.platform).toBe("android");
    expect(native.library).toEqual({
      gradle: "dev.jasonpearson.auto-mobile:auto-mobile-prototype-compose:0.0.88",
    });
    expect(native.minimumLibraryVersion).toBe("0.0.88");
    expect(native.requiredCapabilities).toEqual([
      "prototype_data_model_v1",
      "prototype_network_v1",
      "prototype_storage_v1",
    ]);
    expect(native.files.map((file) => file.path)).toEqual([
      "app/src/main/assets/prototypes/checkout/spec.json",
      "app/src/main/java/prototypes/CheckoutPrototype.kt",
    ]);
    expect(JSON.parse(native.files[0].content)).toEqual(checkout);
    expect(native.files[1].content).toContain("fun CheckoutPrototype(");
    // `data.asset` is author content, not a reference.
    expect(native.assets.map((asset) => [asset.id, asset.kind, asset.available])).toEqual([
      ["hero", "image", false],
      ["brand", "font", false],
    ]);
    expect(native.notes.join("\n")).toContain('via:"host"');
    expect(native.notes.join("\n")).toContain("hero, brand");
  });

  test("iOS output pins the Swift package and mirrors asset bytes from a saved prototype", async () => {
    const native = await readNativePrototype(
      { id: "checkout", platform: "ios", deviceId: "emulator-5554" },
      sources({ saved: { "emulator-5554": [savedCheckout()] } }),
    );
    expect(native.library).toEqual({
      swiftPackage: {
        url: "https://github.com/kaeawc/auto-mobile",
        from: "0.0.88",
        product: "AutoMobilePrototype",
      },
    });
    expect(native.files.map((file) => file.path)).toEqual([
      "Prototypes/checkout/spec.json",
      "Prototypes/CheckoutPrototype.swift",
    ]);
    expect(native.assets[0]).toEqual({
      id: "hero",
      kind: "image",
      mimeType: "image/png",
      path: "Prototypes/checkout/hero.png",
      uri: "automobile:prototype/native/asset?id=checkout&assetId=hero&deviceId=emulator-5554",
      available: true,
    });
    expect(native.notes.join("\n")).toContain("folder reference");
  });

  test("a saved prototype on an unconnected device defaults to Android", async () => {
    const native = await readNativePrototype(
      { id: "checkout", deviceId: "serial" },
      sources({ saved: { serial: [savedCheckout()] } }),
    );
    expect(native.platform).toBe("android");
  });

  test("the asset resource returns saved bytes", async () => {
    const asset = await readNativePrototypeAsset(
      { id: "checkout", assetId: "hero", deviceId: "serial" },
      sources({ saved: { serial: [savedCheckout()] } }),
    );
    expect(asset).toEqual({ mimeType: "image/png", bytes: PNG });
  });

  test("missing asset bytes are an actionable error", async () => {
    const read = readNativePrototypeAsset(
      { id: "checkout", assetId: "brand", deviceId: "serial" },
      sources({ saved: { serial: [savedCheckout()] } }),
    );
    await expect(read).rejects.toBeInstanceOf(ActionableError);
    await expect(read).rejects.toThrow('No bytes for asset "brand"');
  });

  test("an unknown id is an actionable error", async () => {
    await expect(readNativePrototype({ id: "nope" }, sources())).rejects.toThrow(
      'No device is showing prototype "nope"',
    );
    await expect(
      readNativePrototype({ id: "nope", deviceId: "serial", platform: "android" }, sources()),
    ).rejects.toThrow('Unknown prototype "nope" on serial');
  });

  test("an id shown on two devices asks for deviceId", async () => {
    const fake = sources({ shown: { a: checkout, b: checkout } });
    await expect(readNativePrototype({ id: "checkout" }, fake)).rejects.toThrow("pass deviceId");
  });

  test("an unsupported or unknowable platform is an actionable error", async () => {
    const fake = sources({ shown: { a: checkout } });
    await expect(readNativePrototype({ id: "checkout", platform: "web" }, fake)).rejects.toThrow(
      'Unsupported platform "web"',
    );
    await expect(readNativePrototype({ id: "checkout" }, fake)).rejects.toThrow(
      "pass platform=android or platform=ios",
    );
  });

  test("host type names are valid identifiers", () => {
    expect(prototypeHostTypeName("checkout-flow")).toBe("CheckoutFlowPrototype");
    expect(prototypeHostTypeName("2fa")).toBe("P2faPrototype");
  });

  test("the pinned library version is the Android library's release version", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as {
      version: string;
    };
    const gradle = readFileSync(path.join(REPO, "android/gradle.properties"), "utf8");
    const versionName = /^VERSION_NAME=(.+)$/m.exec(gradle)?.[1]?.trim();
    expect(versionName?.replace(/-SNAPSHOT$/, "")).toBe(pkg.version);
  });
});

describe("native host file templates", () => {
  const input: HostFileInput = {
    id: "checkout",
    directory: "checkout",
    typeName: "CheckoutPrototype",
    assets: [
      { id: "hero", kind: "image", path: "x/checkout/hero.png" },
      { id: "brand", kind: "font", path: "x/checkout/brand.ttf" },
    ],
    storage: true,
  };

  test("Compose host file", () => {
    expect(renderComposeHostFile(input)).toMatchSnapshot();
  });

  test("SwiftUI host file", () => {
    expect(renderSwiftUiHostFile(input)).toMatchSnapshot();
  });

  test("without assets or storage the templates use the library defaults", () => {
    const bare = { ...input, assets: [], storage: false };
    expect(renderComposeHostFile(bare)).toContain("images = emptyMap(),");
    expect(renderComposeHostFile(bare)).toContain("storage = PrototypeStorage.None,");
    expect(renderSwiftUiHostFile(bare)).toContain("PrototypeAssets(images: [:], fonts: [:])");
    expect(renderSwiftUiHostFile(bare)).toContain("storage: .none,");
  });
});
