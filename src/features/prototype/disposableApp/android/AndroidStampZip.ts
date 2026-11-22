import AdmZip from "adm-zip";
import { ActionableError } from "../../../../models/ActionableError";
import { assertZipEntriesContained } from "../../../../utils/workers/assertZipEntriesContained";
import type { DisposableAppAsset } from "../DisposableAppManager";
import type { AndroidIconLayers } from "./AndroidIconRenderer";
import { patchArscColors, resolveArscDrawablePaths } from "./androidArscColors";

export const ANDROID_ICON_DRAWABLES = {
  foreground: "prototype_icon_foreground",
  monochrome: "prototype_icon_monochrome",
} as const;
/** What a stamp bakes into the template beside the relinked manifest. */
export interface AndroidStampContent {
  spec: string;
  attachToken?: string;
  /** Development-only opt-in to expose attach on physical Android devices. */
  allowPhysicalDeviceAttach?: boolean;
  assets: readonly DisposableAppAsset[];
  /** ARGB values for named template `color` resources, e.g. the icon and splash background. */
  colors?: ReadonlyMap<string, number>;
  iconLayers?: AndroidIconLayers;
}
export interface AndroidStampZip {
  assemble(template: Buffer, linked: Buffer, content: AndroidStampContent): Buffer;
}
export class DefaultAndroidStampZip implements AndroidStampZip {
  assemble(template: Buffer, linked: Buffer, content: AndroidStampContent): Buffer {
    const { spec, assets, colors = new Map<string, number>() } = content;
    const zip = new AdmZip(template);
    const manifestZip = new AdmZip(linked);
    assertZipEntriesContained(zip, "/stamp", "Android template");
    const manifest = manifestZip.getEntry("AndroidManifest.xml");
    if (!manifest) {
      throw new ActionableError("aapt2 output has no AndroidManifest.xml.");
    }
    for (const entry of zip.getEntries()) {
      if (
        entry.entryName === "AndroidManifest.xml" ||
        isSignature(entry.entryName) ||
        entry.entryName.startsWith("assets/prototype/")
      ) {
        zip.deleteFile(entry);
      }
    }
    zip.addFile("AndroidManifest.xml", manifest.getData());
    zip.addFile("assets/prototype/spec.json", Buffer.from(spec));
    this.addAttachAssets(zip, content);
    const seen = new Set<string>();
    for (const asset of assets) {
      if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(asset.id) || seen.has(asset.id)) {
        throw new ActionableError(`Invalid or duplicate prototype asset id: ${asset.id}`);
      }
      seen.add(asset.id);
      zip.addFile(`assets/prototype/assets/${asset.id}`, Buffer.from(asset.bytes));
    }
    const resources = zip.getEntry("resources.arsc");
    if (!resources) {
      throw new ActionableError("Template APK has no resources.arsc.");
    }
    const arsc = resources.getData();
    if (content.iconLayers) {
      this.replaceIconLayers(zip, arsc, content.iconLayers);
    }
    resources.setData(patchArscColors(arsc, colors));
    resources.header.method = 0;
    return zip.toBuffer();
  }
  private replaceIconLayers(zip: AdmZip, arsc: Buffer, layers: AndroidIconLayers): void {
    const paths = resolveArscDrawablePaths(arsc, Object.values(ANDROID_ICON_DRAWABLES));
    const replaced = new Set<string>();
    for (const layer of ["foreground", "monochrome"] as const) {
      for (const path of paths.get(ANDROID_ICON_DRAWABLES[layer])!) {
        const entry = zip.getEntry(path);
        if (!entry || replaced.has(path)) {
          throw new ActionableError(
            `Template APK needs a distinct file for each icon layer: ${path}. Repackage the template.`,
          );
        }
        entry.setData(layers[layer]);
        entry.header.method = 0;
        replaced.add(path);
      }
    }
  }

  private addAttachAssets(zip: AdmZip, content: AndroidStampContent): void {
    if (content.attachToken !== undefined) {
      zip.addFile("assets/prototype/attach-token", Buffer.from(content.attachToken));
      if (content.allowPhysicalDeviceAttach === true) {
        zip.addFile("assets/prototype/attach-allow-physical-device", Buffer.from("true"));
      }
    }
  }
}
function isSignature(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith("META-INF/") &&
    (upper === "META-INF/MANIFEST.MF" ||
      /\.(SF|RSA|DSA|EC)$/.test(upper) ||
      upper.startsWith("META-INF/SIG-"))
  );
}
