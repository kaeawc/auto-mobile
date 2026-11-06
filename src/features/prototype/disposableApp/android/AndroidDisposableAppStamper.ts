import { createHash } from "node:crypto";
import { join } from "node:path";
import { ActionableError, toActionableError } from "../../../../models/ActionableError";
import { DefaultFileSystem, type FileSystem } from "../../../../utils/filesystem/DefaultFileSystem";
import { defaultIdGenerator, type IdGenerator } from "../../../../utils/IdGenerator";
import { stableStringify } from "../../../../utils/stableStringify";
import { resolveAutoMobileBaseDir } from "../../../../utils/tempDir";
import type {
  DisposableAppStamper,
  DisposableAppStampInput,
  DisposableAppStamped,
} from "../DisposableAppManager";
import { assertDisposableAppId } from "../disposableAppId";
import {
  AndroidDisposableAppTemplateProvider,
  type AndroidDisposableAppTemplate,
  type AndroidDisposableAppTemplateSource,
} from "./androidDisposableAppTemplateProvider";
import { stampAndroidManifest } from "./androidStampManifest";
import { DefaultAndroidStampToolchain, type AndroidStampToolchain } from "./AndroidStampToolchain";
import {
  DefaultAndroidStampZip,
  type AndroidStampZip,
  type AndroidStampAsset,
} from "./AndroidStampZip";
import { HostKeystoreSigner, type DisposableAppSigner } from "./DisposableAppSigner";

export interface AndroidDisposableAppStampInput {
  template: AndroidDisposableAppTemplate;
  appId: string;
  label: string;
  icon?: { backgroundColor: string };
  permissions: readonly string[];
  enabledComponents: readonly string[];
  spec: string;
  assets: readonly AndroidStampAsset[];
  signer: DisposableAppSigner;
}
export interface AndroidDisposableAppStamped extends DisposableAppStamped {
  apkPath: string;
  sha256: string;
  cacheHit: boolean;
}
export interface AndroidDisposableAppStamperDependencies {
  fs?: FileSystem;
  toolchain?: AndroidStampToolchain;
  zip?: AndroidStampZip;
  cacheDir?: string;
  idGenerator?: IdGenerator;
  signer?: DisposableAppSigner;
  provider?: AndroidDisposableAppTemplateSource;
}
export class AndroidDisposableAppStamper implements DisposableAppStamper {
  private readonly fs: FileSystem;
  private readonly tools: AndroidStampToolchain;
  private readonly zip: AndroidStampZip;
  private readonly cacheDir: string;
  private readonly ids: IdGenerator;
  private readonly hostSigner: DisposableAppSigner;
  private readonly provider: AndroidDisposableAppTemplateSource;
  private readonly inFlight = new Map<string, Promise<AndroidDisposableAppStamped>>();
  constructor(deps: AndroidDisposableAppStamperDependencies = {}) {
    this.fs = deps.fs ?? new DefaultFileSystem();
    this.tools = deps.toolchain ?? new DefaultAndroidStampToolchain();
    this.zip = deps.zip ?? new DefaultAndroidStampZip();
    this.cacheDir = deps.cacheDir ?? join(resolveAutoMobileBaseDir(), "prototype-android-cache");
    this.ids = deps.idGenerator ?? defaultIdGenerator;
    this.hostSigner = deps.signer ?? new HostKeystoreSigner();
    this.provider = deps.provider ?? new AndroidDisposableAppTemplateProvider(this.fs);
  }
  async templates(): Promise<readonly AndroidDisposableAppTemplate[]> {
    return [await this.provider.resolve()];
  }
  signer(): Promise<string> {
    return this.hostSigner.signerSha256();
  }
  async stamp(
    input: AndroidDisposableAppStampInput | DisposableAppStampInput,
  ): Promise<AndroidDisposableAppStamped> {
    assertDisposableAppId(input.appId);
    // Adaptive icon replacement is a follow-up; accepting the shape must never silently ignore it.
    if (input.icon !== undefined) {
      throw new ActionableError(
        "Android disposable app icon replacement is not supported yet. Omit icon to use the template icon.",
      );
    }
    const android =
      typeof input.spec === "string"
        ? (input as AndroidDisposableAppStampInput)
        : await this.adapt(input as DisposableAppStampInput);
    try {
      const signer = await android.signer.signerSha256();
      const key = hash(
        stableStringify({
          format: 1,
          apk: android.template.apkSha256,
          templatePackage: android.template.templatePackage,
          manifest: android.template.manifestXml,
          appId: android.appId,
          label: android.label,
          permissions: [...new Set(android.permissions)].sort(),
          enabledComponents: [...new Set(android.enabledComponents)].sort(),
          spec: JSON.parse(android.spec),
          assets: android.assets
            .map((asset) => ({ id: asset.id, sha256: hash(asset.bytes) }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          signer,
        }),
      );
      const existing = this.inFlight.get(key);
      if (existing) {
        return await existing;
      }
      const pending = this.build(android, key, signer);
      this.inFlight.set(key, pending);
      try {
        return await pending;
      } finally {
        this.inFlight.delete(key);
      }
    } catch (error) {
      throw toActionableError(error, "Cannot stamp Android disposable app");
    }
  }
  private async adapt(input: DisposableAppStampInput): Promise<AndroidDisposableAppStampInput> {
    return {
      template: await this.provider.resolve(input.template.name),
      appId: input.appId,
      label: input.label,
      permissions: input.declarations.android.permissions,
      enabledComponents: [],
      spec: stableStringify(input.spec),
      assets: [],
      signer: this.hostSigner,
    };
  }
  private async build(
    input: AndroidDisposableAppStampInput,
    key: string,
    signer: string,
  ): Promise<AndroidDisposableAppStamped> {
    const directory = join(this.cacheDir, key);
    const apkPath = join(directory, "app.apk");
    const receipt = join(directory, "sha256");
    if ((await this.fs.pathExists(receipt)) && (await this.fs.pathExists(apkPath))) {
      const sha256 = hash(await this.fs.readFileBuffer(apkPath));
      if (sha256 === (await this.fs.readFile(receipt))) {
        return { apkPath, sha256, cacheHit: true, artifactPath: apkPath, version: key };
      }
    }
    const staging = join(this.cacheDir, `staging-${this.ids.next()}`);
    await this.fs.ensureDir(staging);
    try {
      const templateBytes = await this.fs.readFileBuffer(input.template.apkPath);
      if (hash(templateBytes) !== input.template.apkSha256) {
        throw new ActionableError(
          "Template APK changed since loading. Reload the template and retry.",
        );
      }
      const manifest = join(staging, "AndroidManifest.xml");
      const linked = join(staging, "linked.apk");
      const assembled = join(staging, "assembled.apk");
      const aligned = join(staging, "aligned.apk");
      const signed = join(staging, "signed.apk");
      await this.fs.writeFile(
        manifest,
        await stampAndroidManifest(input.template.manifestXml, {
          ...input,
          templatePackage: input.template.templatePackage,
        }),
      );
      await this.tools.linkManifest(input.template.apkPath, manifest, linked);
      await this.fs.writeFileBuffer(
        assembled,
        this.zip.assemble(
          templateBytes,
          await this.fs.readFileBuffer(linked),
          stableStringify(JSON.parse(input.spec)),
          input.assets,
        ),
      );
      await this.tools.zipalign(assembled, aligned);
      await this.tools.sign(aligned, signed, input.signer);
      await this.tools.verify(signed, signer);
      const bytes = await this.fs.readFileBuffer(signed);
      const sha256 = hash(bytes);
      await this.fs.ensureDir(directory);
      await this.fs.rename(signed, apkPath);
      await this.fs.writeFile(receipt, sha256);
      return { apkPath, sha256, cacheHit: false, artifactPath: apkPath, version: key };
    } finally {
      await this.fs.remove(staging);
    }
  }
}
function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
