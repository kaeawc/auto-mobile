import { expect, test } from "bun:test";
import AdmZip from "adm-zip";
import { AndroidDisposableAppStamper } from "../../../../../src/features/prototype/disposableApp/android/AndroidDisposableAppStamper";
import { DefaultAndroidStampZip } from "../../../../../src/features/prototype/disposableApp/android/AndroidStampZip";
import { CountingIdGenerator } from "../../../../../src/utils/IdGenerator";
import { FakeFileSystem } from "../../../../fakes/FakeFileSystem";
import { FakeAndroidStampToolchain, FakeAndroidStampZip, stampInput } from "./androidStamperFakes";

function setup() {
  const fs = new FakeFileSystem();
  fs.setDirectory("/template");
  const calls: string[] = [];
  const tools = new FakeAndroidStampToolchain(fs, calls);
  const zip = new FakeAndroidStampZip(calls);
  const stamper = new AndroidDisposableAppStamper({
    fs,
    toolchain: tools,
    zip,
    cacheDir: "/cache",
    idGenerator: new CountingIdGenerator(),
  });
  return { fs, calls, tools, zip, stamper };
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
test("rejects icons and ids outside the disposable prefix before tools", async () => {
  const { calls, stamper } = setup();
  await expect(
    stamper.stamp({ ...stampInput(), icon: { backgroundColor: "#ffffff" } }),
  ).rejects.toThrow("Omit icon");
  await expect(stamper.stamp({ ...stampInput(), appId: "com.real.app" })).rejects.toThrow(
    "not a disposable",
  );
  expect(calls).toEqual([]);
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
    assembly.assemble(template.toBuffer(), linked.toBuffer(), "{}", stampInput().assets),
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
    assembly.assemble(template.toBuffer(), linked.toBuffer(), "{}", [
      { id: "../escape", bytes: Buffer.from("") },
    ]),
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
