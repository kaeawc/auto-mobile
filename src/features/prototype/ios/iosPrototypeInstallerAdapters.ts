import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrototypeJson } from "../prototypeSpec";
import type { PrototypeAssetUpload } from "../prototypeAssets";
import {
  DirectorySavedPrototypeLayoutWriter,
  type SavedPrototypeLayoutWriter,
} from "../savedPrototypeLayout";
import type { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import type {
  DataContainerWriter,
  InstallerFileSystem,
  InstalledPrototype,
  PrototypeSimctl,
} from "./iosPrototypeInstaller";

export class DefaultInstallerFileSystem implements InstallerFileSystem {
  mkdtemp(): Promise<string> {
    return mkdtemp(path.posix.join(tmpdir(), "automobile-prototype-"));
  }
  cp(source: string, destination: string): Promise<void> {
    return cp(source, destination, { recursive: true });
  }
  writeFile(path: string, data: string | Buffer): Promise<void> {
    return writeFile(path, data);
  }
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  rm(path: string): Promise<void> {
    return rm(path, { recursive: true, force: true });
  }
}

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

type SimctlInstallerClient = Pick<
  SimCtlClient,
  "installApp" | "uninstallApp" | "listAppsOrThrow" | "executeCommandArgs"
>;

export class DefaultPrototypeSimctl implements PrototypeSimctl {
  constructor(private readonly client: SimctlInstallerClient) {}
  install(udid: string, appPath: string): Promise<void> {
    return this.client.installApp(appPath, udid);
  }
  uninstall(udid: string, bundleId: string): Promise<void> {
    return this.client.uninstallApp(bundleId, udid);
  }
  async getDataContainer(udid: string, bundleId: string): Promise<string> {
    return (
      await this.client.executeCommandArgs(["get_app_container", udid, bundleId, "data"])
    ).stdout.trim();
  }
  async listApps(udid: string): Promise<InstalledPrototype[]> {
    const apps: unknown[] = await this.client.listAppsOrThrow(udid);
    return apps.flatMap((app) => {
      if (
        !app ||
        typeof app !== "object" ||
        !("bundleId" in app) ||
        typeof app.bundleId !== "string"
      ) {
        return [];
      }
      const name =
        "CFBundleDisplayName" in app
          ? app.CFBundleDisplayName
          : "CFBundleName" in app
            ? app.CFBundleName
            : undefined;
      return [
        { bundleId: app.bundleId, ...(typeof name === "string" ? { displayName: name } : {}) },
      ];
    });
  }
}
