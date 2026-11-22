import { createHash } from "node:crypto";
import { join } from "node:path";
import { ActionableError, toActionableError } from "../../../../models/ActionableError";
import { DefaultFileSystem, type FileSystem } from "../../../../utils/filesystem/DefaultFileSystem";
import { defaultIdGenerator, type IdGenerator } from "../../../../utils/IdGenerator";
import { stableStringify } from "../../../../utils/stableStringify";
import { resolveAutoMobileBaseDir } from "../../../../utils/tempDir";
import type {
  DisposableAppAsset,
  DisposableAppIcon,
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
  type AndroidStampContent,
} from "./AndroidStampZip";
import { HostKeystoreSigner, type DisposableAppSigner } from "./DisposableAppSigner";
import { parsePrototypeHex, prototypeRoleOverrides } from "../../prototypeContrast";
import { record } from "../../prototypeTemplate";
import { DefaultAndroidIconRenderer, type AndroidIconRenderer } from "./AndroidIconRenderer";

/** Template colour behind the adaptive icon and the Android 12+ splash screen. */
export const ANDROID_ICON_BACKGROUND_COLOR = "prototype_icon_background";

export interface AndroidDisposableAppStampInput {
  template: AndroidDisposableAppTemplate;
  appId: string;
  slug: string;
  extraLinkSchemes?: readonly string[];
  label: string;
  icon?: DisposableAppIcon;
  permissions: readonly string[];
  enabledComponents: readonly string[];
  spec: string;
  attachToken?: string;
  /** Development-only opt-in to expose attach on physical Android devices. */
  allowPhysicalDeviceAttach?: boolean;
  assets: readonly DisposableAppAsset[];
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
  iconRenderer?: AndroidIconRenderer;
  cacheDir?: string;
  idGenerator?: IdGenerator;
  signer?: DisposableAppSigner;
  provider?: AndroidDisposableAppTemplateSource;
}
export class AndroidDisposableAppStamper implements DisposableAppStamper {
  private readonly fs: FileSystem;
  private readonly tools: AndroidStampToolchain;
  private readonly zip: AndroidStampZip;
  private readonly iconRenderer: AndroidIconRenderer;
  private readonly cacheDir: string;
  private readonly ids: IdGenerator;
  private readonly hostSigner: DisposableAppSigner;
  private readonly provider: AndroidDisposableAppTemplateSource;
  private readonly inFlight = new Map<string, Promise<AndroidDisposableAppStamped>>();
  constructor(deps: AndroidDisposableAppStamperDependencies = {}) {
    this.fs = deps.fs ?? new DefaultFileSystem();
    this.tools = deps.toolchain ?? new DefaultAndroidStampToolchain();
    this.zip = deps.zip ?? new DefaultAndroidStampZip();
    this.iconRenderer = deps.iconRenderer ?? new DefaultAndroidIconRenderer();
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

    const android =
      typeof input.spec === "string"
        ? (input as AndroidDisposableAppStampInput)
        : await this.adapt(input as DisposableAppStampInput);
    try {
      const spec: unknown = JSON.parse(android.spec);
      const decoration = await this.iconDecoration(android, spec);
      const { iconLayers } = decoration;
      const signer = await android.signer.signerSha256();
      const key = hash(
        stableStringify({
          format: 2,
          slug: android.slug,
          extraLinkSchemes: android.extraLinkSchemes,
          apk: android.template.apkSha256,
          templatePackage: android.template.templatePackage,
          manifest: android.template.manifestXml,
          appId: android.appId,
          label: android.label,
          colors: Object.fromEntries(decoration.colors),
          iconLayers: iconLayers && {
            foreground: hash(iconLayers.foreground),
            monochrome: hash(iconLayers.monochrome),
          },
          permissions: [...new Set(android.permissions)].sort(),
          enabledComponents: [...new Set(android.enabledComponents)].sort(),
          spec,
          attachToken: android.attachToken,
          allowPhysicalDeviceAttach: android.allowPhysicalDeviceAttach === true,
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
      const pending = this.build(android, key, signer, {
        ...decoration,
        spec: stableStringify(spec),
        assets: android.assets,
        attachToken: android.attachToken,
        allowPhysicalDeviceAttach: android.allowPhysicalDeviceAttach,
      });
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
      slug: input.slug,
      attachToken: input.attachToken,
      allowPhysicalDeviceAttach: input.allowPhysicalDeviceAttach,
      label: input.label,
      permissions: input.declarations.android.permissions,
      enabledComponents: [],
      spec: stableStringify(input.spec),
      icon: input.icon,
      assets: input.assets ?? [],
      signer: this.hostSigner,
    };
  }
  private async iconDecoration(input: AndroidDisposableAppStampInput, spec: unknown) {
    const colors = new Map<string, number>();
    const { icon } = input;
    const explicit = icon && "backgroundColor" in icon;
    const background = explicit ? parsePrototypeHex(icon.backgroundColor) : themeBackground(spec);
    if (explicit && !background) {
      throw new ActionableError("Icon backgroundColor must be #RRGGBB or #AARRGGBB.");
    }
    if (background) {
      const { r, g, b, a } = background;
      colors.set(
        ANDROID_ICON_BACKGROUND_COLOR,
        ((Math.round(a * 255) << 24) | (r << 16) | (g << 8) | b) >>> 0,
      );
    }
    if (icon && "asset" in icon) {
      const asset = input.assets.find(({ id }) => id === icon.asset);
      if (!asset) {
        throw new ActionableError(
          `Android icon asset '${icon.asset}' is missing. Supply it in assets with installApp.`,
        );
      }
      return { colors, iconLayers: await this.iconRenderer.render({ bytes: asset.bytes }) };
    }
    return {
      colors,
      iconLayers:
        explicit && background
          ? await this.iconRenderer.render({ label: input.label, background })
          : undefined,
    };
  }
  private async build(
    input: AndroidDisposableAppStampInput,
    key: string,
    signer: string,
    content: AndroidStampContent,
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
        this.zip.assemble(templateBytes, await this.fs.readFileBuffer(linked), content),
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
function themeBackground(spec: unknown) {
  const mode = record(record(spec)?.theme)?.mode === "dark" ? "dark" : "light";
  return new Map(prototypeRoleOverrides(spec, mode)).get("background");
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
