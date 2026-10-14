import type { PrototypeAssetUpload } from "../../src/features/prototype/prototypeAssets";
import type { PrototypeJson } from "../../src/features/prototype/prototypeSpec";
import type {
  DataContainerWriter,
  InstallerFileSystem,
  InstalledPrototype,
  PrototypeSimctl,
  TemplateProvider,
} from "../../src/features/prototype/ios/iosPrototypeInstaller";
import type {
  IconRenderer,
  PrototypeIconInput,
} from "../../src/features/prototype/ios/iosPrototypeIconRenderer";
import type { PlistReader, PlistWriter } from "../../src/utils/ios-cmdline-tools/PlistClient";

export class InstallerOperationRecorder {
  events: string[] = [];
  failAt?: string;
  readonly error = new Error("injected failure");
  record(event: string): void {
    this.events.push(event);
    if (this.failAt === event) {
      throw this.error;
    }
  }
}

export class FakeTemplateProvider implements TemplateProvider {
  constructor(private readonly operations: InstallerOperationRecorder) {}
  async resolve(): Promise<string> {
    this.operations.record("resolve");
    return "/template/Viewer.app";
  }
}

export class FakeInstallerFileSystem implements InstallerFileSystem {
  files = new Map<string, string | Buffer>();
  copies: Array<[string, string]> = [];
  directories: string[] = [];
  removed: string[] = [];
  constructor(private readonly operations: InstallerOperationRecorder) {}
  async mkdtemp(): Promise<string> {
    this.operations.record("mkdtemp");
    return "/temp/install";
  }
  async cp(source: string, destination: string): Promise<void> {
    this.operations.record("copy");
    this.copies.push([source, destination]);
  }
  async writeFile(path: string, data: string | Buffer): Promise<void> {
    this.operations.record(`write:${path}`);
    this.files.set(path, data);
  }
  async mkdir(path: string): Promise<void> {
    this.operations.record(`mkdir:${path}`);
    this.directories.push(path);
  }
  async rm(path: string): Promise<void> {
    this.removed.push(path);
    this.operations.record("cleanup");
  }
}

export class FakePrototypePlist implements PlistReader, PlistWriter {
  value: unknown = { CFBundleExecutable: "PrototypeViewer", CFBundleIcons: { untouched: true } };
  written?: { path: string; value: Record<string, unknown> };
  constructor(private readonly operations: InstallerOperationRecorder) {}
  async readJsonFile(_path: string): Promise<unknown> {
    this.operations.record("plist-read");
    return this.value;
  }
  async writeXmlFromJson(path: string, value: Record<string, unknown>): Promise<void> {
    this.operations.record("plist-write");
    this.written = { path, value };
  }
  async readJsonBytes(_bytes: Buffer): Promise<unknown> {
    return this.value;
  }
  async readXmlFile(_path: string): Promise<string> {
    return "";
  }
  async readXmlBytes(_bytes: Buffer): Promise<string> {
    return "";
  }
  async extractRawFile(_key: string, _path: string): Promise<string> {
    return "";
  }
}

export class FakePrototypeIconRenderer implements IconRenderer {
  inputs: Array<{ input: PrototypeIconInput; sizePx: number }> = [];
  constructor(private readonly operations: InstallerOperationRecorder) {}
  async render(input: PrototypeIconInput, sizePx: number): Promise<Buffer> {
    this.operations.record(`icon:${sizePx}`);
    this.inputs.push({ input, sizePx });
    return Buffer.from(`png:${sizePx}`);
  }
}

export class FakePrototypeSimctl implements PrototypeSimctl {
  apps: InstalledPrototype[] = [];
  installed: Array<{ udid: string; appPath: string }> = [];
  containers: string[] = [];
  deleted: string[] = [];
  containerPath = "/container";
  constructor(private readonly operations: InstallerOperationRecorder) {}
  async install(udid: string, appPath: string): Promise<void> {
    this.operations.record("install");
    this.installed.push({ udid, appPath });
  }
  async getDataContainer(_udid: string, bundleId: string): Promise<string> {
    this.operations.record("container");
    this.containers.push(bundleId);
    return this.containerPath;
  }
  async listApps(_udid: string): Promise<InstalledPrototype[]> {
    this.operations.record("list");
    return this.apps;
  }
  async uninstall(_udid: string, bundleId: string): Promise<void> {
    this.operations.record("uninstall");
    this.deleted.push(bundleId);
  }
}

export class FakePrototypeDataWriter implements DataContainerWriter {
  writes: Array<{
    containerPath: string;
    spec: PrototypeJson;
    assets?: readonly PrototypeAssetUpload[];
  }> = [];
  constructor(private readonly operations: InstallerOperationRecorder) {}
  async write(
    containerPath: string,
    spec: PrototypeJson,
    assets?: readonly PrototypeAssetUpload[],
  ): Promise<void> {
    this.operations.record("data");
    this.writes.push({ containerPath, spec, assets });
  }
}
