import { expect, test } from "bun:test";
import AdmZip from "adm-zip";
import {
  ANDROID_ICON_BACKGROUND_COLOR,
  AndroidDisposableAppStamper,
} from "../../../../../src/features/prototype/disposableApp/android/AndroidDisposableAppStamper";
import {
  DefaultAndroidIconRenderer,
  type AndroidIconRenderer,
} from "../../../../../src/features/prototype/disposableApp/android/AndroidIconRenderer";
import { ActionableError } from "../../../../../src/models/ActionableError";
import { arsc, foregroundPath, monochromePath } from "./androidArscFixture";
import { DefaultAndroidStampZip } from "../../../../../src/features/prototype/disposableApp/android/AndroidStampZip";
import { CountingIdGenerator } from "../../../../../src/utils/IdGenerator";
import { FakeFileSystem } from "../../../../fakes/FakeFileSystem";
import { FakeAndroidStampToolchain, FakeAndroidStampZip, stampInput } from "./androidStamperFakes";

function setup() {
  const renders: Parameters<AndroidIconRenderer["render"]>[0][] = [];
  let foreground = Buffer.from("foreground");
  const iconRenderer: AndroidIconRenderer = {
    async render(source) {
      renders.push(source);
      return { foreground, monochrome: Buffer.from("monochrome") };
    },
  };
  const fs = new FakeFileSystem();
  fs.setDirectory("/template");
  const calls: string[] = [];
  const tools = new FakeAndroidStampToolchain(fs, calls);
  const zip = new FakeAndroidStampZip(calls);
  const stamper = new AndroidDisposableAppStamper({
    fs,
    toolchain: tools,
    zip,
    iconRenderer,
    cacheDir: "/cache",
    idGenerator: new CountingIdGenerator(),
  });
  return {
    fs,
    calls,
    tools,
    zip,
    stamper,
    renders,
    changeForeground: () => {
      foreground = Buffer.from("changed foreground");
    },
  };
}
test("cache miss follows link, zip, align, sign, verify; cache hit skips tools", async () => {
  const { fs, calls, zip, stamper } = setup();
  const input = stampInput();
  await fs.writeFileBuffer(input.template.apkPath, Buffer.from("template"));
  const first = await stamper.stamp(input);
  expect(first.cacheHit).toBe(false);
  expect(calls).toEqual(["link", "zip", "zipalign", "sign", "verify"]);
  expect(zip.spec).toBe(input.spec);
  expect(zip.assets).toEqual(input.assets);
  expect(await stamper.stamp(input)).toEqual({ ...first, cacheHit: true });
  expect(calls.length).toBe(5);
  expect((await stamper.stamp({ ...input, label: "Other" })).apkPath).not.toBe(first.apkPath);
});
test("rejects missing assets, bad colours and ids outside the disposable prefix before tools", async () => {
  const { calls, stamper } = setup();
  await expect(stamper.stamp({ ...stampInput(), icon: { asset: "logo" } })).rejects.toThrow(
    "icon asset",
  );
  await expect(
    stamper.stamp({ ...stampInput(), icon: { backgroundColor: "red" } }),
  ).rejects.toThrow("#AARRGGBB");
  await expect(stamper.stamp({ ...stampInput(), appId: "com.real.app" })).rejects.toThrow(
    "not a disposable",
  );
  expect(calls).toEqual([]);
});
test("icon backgroundColor recolours the icon and splash background and keys the cache", async () => {
  const { fs, zip, stamper, renders } = setup();
  const input = stampInput();
  await fs.writeFileBuffer(input.template.apkPath, Buffer.from("template"));
  const plain = await stamper.stamp(input);
  expect(zip.colors.size).toBe(0);
  expect(zip.iconLayers).toBeUndefined();
  expect(renders).toEqual([]);
  const red = await stamper.stamp({
    ...input,
    spec: JSON.stringify({ theme: { colors: { background: "#010203" } } }),
    icon: { backgroundColor: "#C62828" },
  });
  expect(zip.colors).toEqual(new Map([[ANDROID_ICON_BACKGROUND_COLOR, 0xffc62828]]));
  expect(renders[0]).toEqual({ label: "Feedly", background: { r: 198, g: 40, b: 40, a: 1 } });
  expect(zip.iconLayers?.foreground).toEqual(Buffer.from("foreground"));
  const translucent = await stamper.stamp({ ...input, icon: { backgroundColor: "#80C62828" } });
  expect(zip.colors.get(ANDROID_ICON_BACKGROUND_COLOR)).toBe(0x80c62828);
  expect(new Set([plain.apkPath, red.apkPath, translucent.apkPath]).size).toBe(3);
});
test("asset icons and omitted icons use the authored theme background", async () => {
  const { fs, zip, stamper, renders, changeForeground } = setup();
  const input = {
    ...stampInput(),
    spec: '{"theme":{"mode":"dark","colors":{"background":"#FFFFFF","dark":{"background":"#80445566"}}}}',
  };
  await fs.writeFileBuffer(input.template.apkPath, Buffer.from("template"));
  await stamper.stamp(input);
  expect(zip.colors.get(ANDROID_ICON_BACKGROUND_COLOR)).toBe(0x80445566);
  expect(zip.iconLayers).toBeUndefined();

  const assetInput = { ...input, icon: { asset: "logo.png" } };
  const first = await stamper.stamp(assetInput);
  expect(renders[0]).toEqual({ bytes: input.assets[0]!.bytes });
  expect(zip.colors.get(ANDROID_ICON_BACKGROUND_COLOR)).toBe(0x80445566);
  expect(zip.iconLayers?.monochrome).toEqual(Buffer.from("monochrome"));
  changeForeground();
  const second = await stamper.stamp(assetInput);
  expect(second.version).not.toBe(first.version);

  await stamper.stamp({ ...assetInput, spec: "{}" });
  expect(zip.colors.size).toBe(0);
});

test("a corrupt PNG asset fails before the toolchain runs", async () => {
  const fs = new FakeFileSystem();
  const tools = new FakeAndroidStampToolchain(fs);
  const stamper = new AndroidDisposableAppStamper({
    fs,
    toolchain: tools,
    cacheDir: "/cache",
    iconRenderer: new DefaultAndroidIconRenderer(
      {
        async rawPixels() {
          throw new Error("truncated PNG");
        },
      },
      async () => {
        throw new Error("unreachable Jimp loader");
      },
    ),
  });
  const failure = stamper.stamp({
    ...stampInput(),
    icon: { asset: "broken" },
    assets: [{ id: "broken", bytes: Buffer.from("89504e470d0a1a0a", "hex") }],
  });
  await expect(failure).rejects.toBeInstanceOf(ActionableError);
  await expect(failure).rejects.toThrow("decodable PNG or JPEG");
  expect(tools.calls).toEqual([]);
});

test("ZIP replaces the two shortened drawable paths and preserves them when no icon is supplied", () => {
  const template = new AdmZip();
  template.addFile("resources.arsc", arsc());
  template.addFile(foregroundPath, Buffer.from("old foreground"));
  template.addFile(monochromePath, Buffer.from("old monochrome"));
  const linked = new AdmZip();
  linked.addFile("AndroidManifest.xml", Buffer.from("manifest"));
  const zip = new DefaultAndroidStampZip();
  const layers = {
    foreground: Buffer.from("new foreground"),
    monochrome: Buffer.from("new monochrome"),
  };
  const assemble = (iconLayers?: typeof layers) =>
    new AdmZip(
      zip.assemble(template.toBuffer(), linked.toBuffer(), {
        spec: "{}",
        assets: [],
        iconLayers,
      }),
    );
  const replaced = assemble(layers);
  expect(replaced.getEntry(foregroundPath)?.header.method).toBe(0);
  expect(replaced.getEntry(monochromePath)?.header.method).toBe(0);
  expect(replaced.readAsText(foregroundPath)).toBe("new foreground");
  expect(replaced.readAsText(monochromePath)).toBe("new monochrome");
  const plain = assemble();
  expect(plain.readAsText(foregroundPath)).toBe("old foreground");
  expect(plain.readAsText(monochromePath)).toBe("old monochrome");
  template.deleteFile(monochromePath);
  expect(() => assemble(layers)).toThrow("distinct file for each icon layer");
});

test("failed verification never creates a cache receipt", async () => {
  const { fs, tools, stamper } = setup();
  const input = stampInput();
  await fs.writeFileBuffer(input.template.apkPath, Buffer.from("template"));
  tools.verify = async () => {
    throw new Error("bad signature");
  };
  await expect(stamper.stamp(input)).rejects.toThrow("bad signature");
  expect([...fs.getWrittenFiles().keys()].some((path) => path.endsWith("/sha256"))).toBe(false);
});
test("ZIP replaces manifest and spec, drops signatures, stores resources, and contains assets", () => {
  const template = new AdmZip();
  for (const name of [
    "AndroidManifest.xml",
    "classes.dex",
    "resources.arsc",
    "META-INF/MANIFEST.MF",
    "META-INF/OLD.SF",
    "META-INF/OLD.RSA",
    "META-INF/services/test",
    "assets/prototype/old.json",
  ]) {
    template.addFile(name, Buffer.from("old"));
  }
  const linked = new AdmZip();
  linked.addFile("AndroidManifest.xml", Buffer.from("binary manifest"));
  const assembly = new DefaultAndroidStampZip();
  const result = new AdmZip(
    assembly.assemble(template.toBuffer(), linked.toBuffer(), {
      spec: "{}",
      assets: stampInput().assets,
    }),
  );
  expect(result.readAsText("AndroidManifest.xml")).toBe("binary manifest");
  expect(result.readAsText("assets/prototype/spec.json")).toBe("{}");
  expect(result.readAsText("assets/prototype/assets/logo.png")).toBe("image");
  expect(result.getEntry("resources.arsc")?.header.method).toBe(0);
  expect(result.getEntry("classes.dex")).not.toBeNull();
  expect(result.getEntry("META-INF/services/test")).not.toBeNull();
  expect(result.getEntry("META-INF/OLD.RSA")).toBeNull();
  expect(result.getEntry("META-INF/OLD.SF")).toBeNull();
  expect(result.getEntry("assets/prototype/old.json")).toBeNull();
  expect(() =>
    assembly.assemble(template.toBuffer(), linked.toBuffer(), {
      spec: "{}",
      assets: [{ id: "../escape", bytes: Buffer.from("") }],
    }),
  ).toThrow("Invalid");
});

test("corrupt cached bytes are rebuilt rather than returned", async () => {
  const { fs, calls, stamper } = setup();
  const input = stampInput();
  await fs.writeFileBuffer(input.template.apkPath, Buffer.from("template"));
  const first = await stamper.stamp(input);
  await fs.writeFileBuffer(first.apkPath, Buffer.from("corrupt"));
  expect((await stamper.stamp(input)).cacheHit).toBe(false);
  expect(calls.filter((call) => call === "verify")).toHaveLength(2);
});

test("canonical spec keys and permission order share a cache entry", async () => {
  const { fs, stamper } = setup();
  const input = {
    ...stampInput(),
    spec: '{"root":{"type":"column"},"version":1}',
    permissions: ["android.permission.CAMERA", "android.permission.INTERNET"],
  };
  await fs.writeFileBuffer(input.template.apkPath, Buffer.from("template"));
  const first = await stamper.stamp(input);
  const second = await stamper.stamp({
    ...input,
    spec: '{"version":1,"root":{"type":"column"}}',
    permissions: [...input.permissions].reverse(),
  });
  expect(second.apkPath).toBe(first.apkPath);
  expect(second.cacheHit).toBe(true);
});

test("ZIP assembly patches stamped colours into resources.arsc", () => {
  const template = new AdmZip();
  template.addFile("resources.arsc", Buffer.from("not a table"));
  const linked = new AdmZip();
  linked.addFile("AndroidManifest.xml", Buffer.from("binary manifest"));
  const colors = new Map([[ANDROID_ICON_BACKGROUND_COLOR, 0xffc62828]]);
  expect(() =>
    new DefaultAndroidStampZip().assemble(template.toBuffer(), linked.toBuffer(), {
      spec: "{}",
      assets: [],
      colors,
    }),
  ).toThrow("resources.arsc");
});

test("inbound scheme stamp inputs invalidate the APK cache", async () => {
  const { fs, stamper } = setup();
  const input = stampInput();
  await fs.writeFileBuffer(input.template.apkPath, Buffer.from("template"));
  const first = await stamper.stamp(input);
  expect((await stamper.stamp({ ...input, slug: "reader" })).apkPath).not.toBe(first.apkPath);
  expect((await stamper.stamp({ ...input, extraLinkSchemes: ["reader"] })).apkPath).not.toBe(
    first.apkPath,
  );
});

test("attach tokens key the cache and replace the template secret", async () => {
  const { fs, stamper } = setup();
  const input = stampInput();
  await fs.writeFileBuffer(input.template.apkPath, Buffer.from("template"));
  const first = await stamper.stamp({ ...input, attachToken: "a".repeat(64) });
  const second = await stamper.stamp({ ...input, attachToken: "b".repeat(64) });
  expect(first.version).not.toBe(second.version);
  const template = new AdmZip();
  template.addFile("resources.arsc", Buffer.from("old"));
  template.addFile("assets/prototype/attach-token", Buffer.from("old-secret"));
  const linked = new AdmZip();
  linked.addFile("AndroidManifest.xml", Buffer.from("manifest"));
  const result = new AdmZip(
    new DefaultAndroidStampZip().assemble(template.toBuffer(), linked.toBuffer(), {
      spec: "{}",
      assets: [],
      attachToken: "a".repeat(64),
    }),
  );
  expect(result.readAsText("assets/prototype/attach-token")).toBe("a".repeat(64));
});

test("physical-device listener opt-in changes cache and is stamped only with a token", async () => {
  const { fs, stamper } = setup();
  const input = stampInput();
  await fs.writeFileBuffer(input.template.apkPath, Buffer.from("template"));
  const first = await stamper.stamp({ ...input, attachToken: "a".repeat(64) });
  const optedIn = await stamper.stamp({
    ...input,
    attachToken: "a".repeat(64),
    allowPhysicalDeviceAttach: true,
  });
  expect(first.version).not.toBe(optedIn.version);
  const template = new AdmZip();
  template.addFile("resources.arsc", Buffer.from("old"));
  template.addFile("assets/prototype/attach-allow-physical-device", Buffer.from("true"));
  const linked = new AdmZip();
  linked.addFile("AndroidManifest.xml", Buffer.from("manifest"));
  const stamp = (allowPhysicalDeviceAttach: boolean, attachToken?: string) =>
    new AdmZip(
      new DefaultAndroidStampZip().assemble(template.toBuffer(), linked.toBuffer(), {
        spec: "{}",
        assets: [],
        allowPhysicalDeviceAttach,
        attachToken,
      }),
    );
  expect(
    stamp(false, "token").getEntry("assets/prototype/attach-allow-physical-device"),
  ).toBeNull();
  expect(stamp(true).getEntry("assets/prototype/attach-allow-physical-device")).toBeNull();
  expect(stamp(true, "token").readAsText("assets/prototype/attach-allow-physical-device")).toBe(
    "true",
  );
});
