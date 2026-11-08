import AdmZip from "adm-zip";
import { ActionableError } from "../../../../models/ActionableError";
import { assertZipEntriesContained } from "../../../../utils/workers/assertZipEntriesContained";

export interface AndroidStampAsset {
  id: string;
  bytes: Uint8Array;
}
export interface AndroidStampZip {
  assemble(
    template: Buffer,
    linked: Buffer,
    spec: string,
    assets: readonly AndroidStampAsset[],
  ): Buffer;
}
export class DefaultAndroidStampZip implements AndroidStampZip {
  assemble(
    template: Buffer,
    linked: Buffer,
    spec: string,
    assets: readonly AndroidStampAsset[],
  ): Buffer {
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
    resources.setData(resources.getData());
    resources.header.method = 0;
    return zip.toBuffer();
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
