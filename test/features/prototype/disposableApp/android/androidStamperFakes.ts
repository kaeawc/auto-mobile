import { createHash } from "node:crypto";
import type { AndroidStampToolchain } from "../../../../../src/features/prototype/disposableApp/android/AndroidStampToolchain";
import type {
  AndroidStampZip,
  AndroidStampAsset,
} from "../../../../../src/features/prototype/disposableApp/android/AndroidStampZip";
import type { DisposableAppSigner } from "../../../../../src/features/prototype/disposableApp/android/DisposableAppSigner";
import type { AndroidDisposableAppStampInput } from "../../../../../src/features/prototype/disposableApp/android/AndroidDisposableAppStamper";
import { FakeFileSystem } from "../../../../fakes/FakeFileSystem";

export class FakeDisposableAppSigner implements DisposableAppSigner {
  async signerSha256(): Promise<string> {
    return "a".repeat(64);
  }
  async sign(_tool: string, _input: string, _output: string): Promise<void> {}
}
export class FakeAndroidStampToolchain implements AndroidStampToolchain {
  constructor(
    private readonly fs: FakeFileSystem,
    readonly calls: string[] = [],
  ) {}
  async linkManifest(_template: string, _manifest: string, output: string): Promise<void> {
    this.calls.push("link");
    await this.fs.writeFileBuffer(output, Buffer.from("linked"));
  }
  async zipalign(_input: string, output: string): Promise<void> {
    this.calls.push("zipalign");
    await this.fs.writeFileBuffer(output, Buffer.from("aligned"));
  }
  async sign(_input: string, output: string): Promise<void> {
    this.calls.push("sign");
    await this.fs.writeFileBuffer(output, Buffer.from("signed"));
  }
  async verify(): Promise<void> {
    this.calls.push("verify");
  }
}
export class FakeAndroidStampZip implements AndroidStampZip {
  spec = "";
  assets: readonly AndroidStampAsset[] = [];
  constructor(private readonly calls: string[]) {}
  assemble(
    _template: Buffer,
    _linked: Buffer,
    spec: string,
    assets: readonly AndroidStampAsset[],
  ): Buffer {
    this.calls.push("zip");
    this.spec = spec;
    this.assets = assets;
    return Buffer.from("assembled");
  }
}
export function stampInput(): AndroidDisposableAppStampInput {
  const templatePackage = "dev.jasonpearson.automobile.app.template";
  return {
    template: {
      apkPath: "/template/template.apk",
      apkSha256: createHash("sha256").update("template").digest("hex"),
      templatePackage,
      manifestXml: `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${templatePackage}"><application android:label="Template"/></manifest>`,
      capabilities: [],
      name: "base",
      size: 8,
    },
    appId: "dev.jasonpearson.automobile.app.feedly",
    label: "Feedly",
    spec: '{"root":{"type":"column"}}',
    permissions: [],
    enabledComponents: [],
    assets: [{ id: "logo.png", bytes: Buffer.from("image") }],
    signer: new FakeDisposableAppSigner(),
  };
}
