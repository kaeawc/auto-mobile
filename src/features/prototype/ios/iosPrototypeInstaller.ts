import path from "node:path";
import { toActionableError, type ActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";
import type { HostCommandExecutor } from "../../../utils/HostCommandExecutor";
import type { PlistReader, PlistWriter } from "../../../utils/ios-cmdline-tools/PlistClient";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import type { PrototypeJson } from "../prototypeSpec";
import { isPrototypeBundleId, prototypeBundleId } from "./iosPrototypeBundleId";
import type { IconRenderer, PrototypeIconInput } from "./iosPrototypeIconRenderer";
import {
  CodesignError,
  DataContainerError,
  DataWriteError,
  IconRenderError,
  NotPrototypeBundleError,
  PlistRewriteError,
  PrototypeInstallPhysicalDeviceError,
  PrototypeListError,
  PrototypeUninstallError,
  SimctlInstallError,
  TemplateCopyError,
  TemplateResolveError,
} from "./iosPrototypeInstallerErrors";

export interface TemplateProvider {
  resolve(): Promise<string>;
}

export interface InstallerFileSystem {
  mkdtemp(): Promise<string>;
  cp(source: string, destination: string): Promise<void>;
  writeFile(path: string, data: string | Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export interface DataContainerWriter {
  write(containerPath: string, spec: PrototypeJson): Promise<void>;
}

export interface InstalledPrototype {
  bundleId: string;
  displayName?: string;
}

export interface PrototypeSimctl {
  install(udid: string, appPath: string): Promise<void>;
  getDataContainer(udid: string, bundleId: string): Promise<string>;
  listApps(udid: string): Promise<InstalledPrototype[]>;
  uninstall(udid: string, bundleId: string): Promise<void>;
}

export interface PrototypeInstallerDependencies {
  template: TemplateProvider;
  files: InstallerFileSystem;
  plist: PlistReader & PlistWriter;
  icons: IconRenderer;
  commands: HostCommandExecutor;
  simctl: PrototypeSimctl;
  data: DataContainerWriter;
}

export interface PrototypeInstallInput {
  udid: string;
  prototypeId: string;
  label?: string;
  spec: PrototypeJson;
  icon?: PrototypeIconInput;
}

async function step<T>(
  run: () => Promise<T>,
  error: (cause: unknown) => ActionableError,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw error(cause);
  }
}

function requireSimulator(udid: string): void {
  if (resolveIosDeviceKind({ deviceId: udid }) !== "simulator") {
    throw new PrototypeInstallPhysicalDeviceError();
  }
}

/** Host library only; #12257 owns the MCP entry point. Reinstallation preserves simulator data. */
export class IosPrototypeInstaller {
  constructor(private readonly deps: PrototypeInstallerDependencies) {}

  async install(input: PrototypeInstallInput): Promise<InstalledPrototype> {
    requireSimulator(input.udid);
    const bundleId = prototypeBundleId(input.prototypeId);
    const displayName = input.label ?? input.prototypeId;
    const template = await step(
      () => this.deps.template.resolve(),
      (cause) => new TemplateResolveError(cause),
    );
    const temp = await step(
      () => this.deps.files.mkdtemp(),
      (cause) => new TemplateCopyError(cause),
    );
    const app = path.posix.join(temp, "PrototypeViewer.app");
    try {
      await step(
        () => this.deps.files.cp(template, app),
        (cause) => new TemplateCopyError(cause),
      );
      await step(
        () => this.rewritePlist(app, bundleId, displayName),
        (cause) => new PlistRewriteError(cause),
      );
      await step(
        () => this.writeIcons(app, input.icon ?? {}),
        (cause) => new IconRenderError(cause),
      );
      await this.codesign(app, "sign");
      await this.codesign(app, "verify");
      await step(
        () => this.deps.simctl.install(input.udid, app),
        (cause) => new SimctlInstallError(cause),
      );
      const container = await step(
        async () => {
          const path = await this.deps.simctl.getDataContainer(input.udid, bundleId);
          if (!path.trim()) {
            throw new Error("Simulator returned an empty data container path");
          }
          return path;
        },
        (cause) => new DataContainerError(cause),
      );
      await step(
        () => this.deps.data.write(container, input.spec),
        (cause) => new DataWriteError(cause),
      );
      return { bundleId, displayName };
    } catch (cause) {
      throw toActionableError(cause, "Prototype viewer installation failed");
    } finally {
      try {
        await this.deps.files.rm(temp);
      } catch (cause) {
        logger.warn("Could not remove temporary prototype viewer directory", {
          temp,
          error: cause,
        });
      }
    }
  }

  async list(udid: string): Promise<InstalledPrototype[]> {
    requireSimulator(udid);
    const apps = await step(
      () => this.deps.simctl.listApps(udid),
      (cause) => new PrototypeListError(cause),
    );
    return apps.filter((app) => isPrototypeBundleId(app.bundleId));
  }

  /** Strings are bundle IDs; the explicit prototypeId form avoids confusing foreign bundle IDs with ids. */
  async delete(udid: string, target: string | { prototypeId: string }): Promise<void> {
    requireSimulator(udid);
    const bundleId = typeof target === "string" ? target : prototypeBundleId(target.prototypeId);
    if (!isPrototypeBundleId(bundleId)) {
      throw new NotPrototypeBundleError();
    }
    await step(
      () => this.deps.simctl.uninstall(udid, bundleId),
      (cause) => new PrototypeUninstallError(cause),
    );
  }

  private async rewritePlist(app: string, bundleId: string, displayName: string): Promise<void> {
    const plistPath = path.posix.join(app, "Info.plist");
    const value = await this.deps.plist.readJsonFile(plistPath);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Template Info.plist must be a dictionary");
    }
    await this.deps.plist.writeXmlFromJson(plistPath, {
      ...value,
      CFBundleIdentifier: bundleId,
      CFBundleDisplayName: displayName,
      CFBundleName: displayName,
    });
  }

  private async writeIcons(app: string, input: PrototypeIconInput): Promise<void> {
    for (const [size, scale] of [
      [120, 2],
      [180, 3],
    ]) {
      const png = await this.deps.icons.render(input, size);
      await this.deps.files.writeFile(
        path.posix.join(app, `PrototypeViewerIcon60x60@${scale}x.png`),
        png,
      );
    }
  }

  private async codesign(app: string, phase: "sign" | "verify"): Promise<void> {
    // `codesign --force --sign -` intentionally drops entitlements; the template has none.
    const args =
      phase === "sign" ? ["--force", "--sign", "-", "--timestamp=none", app] : ["--verify", app];
    await step(
      () => this.deps.commands.executeCommand("codesign", args),
      (cause) => new CodesignError(phase, cause),
    );
  }
}
