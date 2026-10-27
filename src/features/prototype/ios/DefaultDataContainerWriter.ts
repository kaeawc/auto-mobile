import path from "node:path";
import type { PrototypeJson } from "../prototypeSpec";
import type { PrototypeAssetUpload } from "../prototypeAssets";
import {
  DirectorySavedPrototypeLayoutWriter,
  type SavedPrototypeLayoutWriter,
} from "../savedPrototypeLayout";
import type { DataContainerWriter, InstallerFileSystem } from "./iosPrototypeInstaller";
import { DefaultInstallerFileSystem } from "./DefaultInstallerFileSystem";

export class DefaultDataContainerWriter implements DataContainerWriter {
  constructor(
    private readonly layout: SavedPrototypeLayoutWriter = new DirectorySavedPrototypeLayoutWriter(),
    private readonly files: Pick<InstallerFileSystem, "rm"> = new DefaultInstallerFileSystem(),
  ) {}
  async write(
    containerPath: string,
    spec: PrototypeJson,
    assets?: readonly PrototypeAssetUpload[],
  ): Promise<void> {
    const result = await this.layout.write(
      {
        specJson: JSON.stringify(spec),
        assets: (assets ?? []).map((asset) => ({
          id: asset.id,
          mediaType: asset.mimeType,
          bytes: asset.bytes,
        })),
      },
      path.posix.join(containerPath, "Documents", "prototype"),
    );
    if (result.kind === "rejected") {
      throw Object.assign(new Error(result.message), { reason: result.reason });
    }
    await this.files.rm(path.posix.join(containerPath, "Documents", "prototype.json"));
  }
}
