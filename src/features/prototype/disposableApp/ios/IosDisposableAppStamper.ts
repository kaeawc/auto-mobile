import path from "node:path";
import { ActionableError, toActionableError } from "../../../../models/ActionableError";
import type { HostCommandExecutor } from "../../../../utils/HostCommandExecutor";
import type { PlistReader, PlistWriter } from "../../../../utils/ios-cmdline-tools/PlistClient";
import { logger } from "../../../../utils/logger";
import { prototypeContractPatterns } from "../../prototypeContractPatterns";
import type { IconRenderer } from "../../ios/iosPrototypeIconRenderer";
import type { InstallerFileSystem, TemplateProvider } from "../../ios/iosPrototypeInstaller";
import type {
  DisposableAppIcon,
  DisposableAppStamper,
  DisposableAppStamped,
  DisposableAppStampInput,
} from "../DisposableAppManager";
import { assertDisposableAppId } from "../disposableAppId";
import { DISPOSABLE_APP_IOS_USAGE_KEYS } from "../disposableAppPermissions";
import type { DisposableAppTemplate } from "../disposableAppTemplates";
import { IOS_DISPOSABLE_APP_SIGNER, IOS_DISPOSABLE_APP_SPEC } from "./iosDisposableAppIdentity";
import { IOS_DISPOSABLE_APP_TEMPLATE } from "./iosDisposableAppTemplate";

const USAGE_KEYS = new Set(Object.values(DISPOSABLE_APP_IOS_USAGE_KEYS));

interface IosDisposableAppStamperDependencies {
  template: TemplateProvider;
  files: Pick<InstallerFileSystem, "mkdtemp" | "cp" | "writeFile" | "rm">;
  plist: PlistReader & PlistWriter;
  icons: IconRenderer;
  commands: HostCommandExecutor;
}

function iconColor(icon: DisposableAppIcon | undefined): string | undefined {
  if (icon === undefined) {
    return undefined;
  }
  if ("asset" in icon) {
    throw new ActionableError(
      "iOS disposable apps do not support an icon asset yet. Use icon.backgroundColor or omit icon.",
    );
  }
  const color = icon.backgroundColor;
  if (!prototypeContractPatterns.color.test(color)) {
    throw new ActionableError("Icon backgroundColor must be #RRGGBB or #AARRGGBB.");
  }
  // The prototype contract uses #AARRGGBB, while the Viewer icon renderer takes #RRGGBBAA.
  return color.length === 9 ? `#${color.slice(3)}${color.slice(1, 3)}` : color;
}

function launchScreenWithoutNamedColor(value: unknown): Record<string, unknown> {
  const settings: Record<string, unknown> =
    value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  // UIColorName refers to a compiled asset catalog entry and cannot accept a hex color.
  delete settings.UIColorName;
  return settings;
}

export class IosDisposableAppStamper implements DisposableAppStamper {
  constructor(private readonly deps: IosDisposableAppStamperDependencies) {}

  async templates(): Promise<readonly DisposableAppTemplate[]> {
    return [IOS_DISPOSABLE_APP_TEMPLATE];
  }

  async signer(): Promise<string> {
    return IOS_DISPOSABLE_APP_SIGNER;
  }

  async stamp(input: DisposableAppStampInput): Promise<DisposableAppStamped> {
    assertDisposableAppId(input.appId);
    if (input.template.name !== IOS_DISPOSABLE_APP_TEMPLATE.name) {
      throw new ActionableError(
        `Unknown iOS disposable app template "${input.template.name}". Use base.`,
      );
    }
    for (const key of Object.keys(input.declarations.ios.usageDescriptions)) {
      if (!/^NS[A-Za-z]+UsageDescription$/.test(key) || !USAGE_KEYS.has(key)) {
        throw new ActionableError(`Unknown iOS disposable app usage-description key "${key}".`);
      }
    }
    const backgroundColor = iconColor(input.icon);
    let temp: string | undefined;
    try {
      const template = await this.deps.template.resolve();
      temp = await this.deps.files.mkdtemp();
      const artifactPath = path.join(temp, "PrototypeViewer.app");
      await this.deps.files.cp(template, artifactPath);
      const version = await this.rewritePlist(artifactPath, input, backgroundColor !== undefined);
      if (backgroundColor !== undefined) {
        await this.writeIcons(artifactPath, backgroundColor);
      }
      // ViewerApp reads this signed resource as a fallback and storage reset uses it to reseed.
      await this.deps.files.writeFile(
        path.join(artifactPath, IOS_DISPOSABLE_APP_SPEC),
        JSON.stringify(input.spec),
      );
      await this.deps.commands.executeCommand("codesign", [
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        artifactPath,
      ]);
      await this.deps.commands.executeCommand("codesign", ["--verify", artifactPath]);
      return { artifactPath, version };
    } catch (error) {
      if (temp !== undefined) {
        await this.removeFailedStamp(temp);
      }
      throw toActionableError(error, "Cannot stamp iOS disposable app");
    }
  }

  private async rewritePlist(
    app: string,
    input: DisposableAppStampInput,
    coloredIcon: boolean,
  ): Promise<string> {
    const plistPath = path.join(app, "Info.plist");
    const value = await this.deps.plist.readJsonFile(plistPath);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ActionableError("Template Info.plist must be a dictionary.");
    }
    const plist: Record<string, unknown> = { ...value };
    const version = plist.CFBundleShortVersionString ?? plist.CFBundleVersion;
    if (typeof version !== "string" || !version.trim()) {
      throw new ActionableError("Template Info.plist must specify an app version.");
    }
    for (const key of Object.keys(plist)) {
      if (/^NS.*UsageDescription$/.test(key) || key === "UIBackgroundModes") {
        delete plist[key];
      }
    }
    const { usageDescriptions, backgroundModes } = input.declarations.ios;
    if (backgroundModes.length > 0) {
      plist.UIBackgroundModes = backgroundModes;
    }
    if (coloredIcon) {
      plist.UILaunchScreen = launchScreenWithoutNamedColor(plist.UILaunchScreen);
    }
    await this.deps.plist.writeXmlFromJson(plistPath, {
      ...plist,
      ...usageDescriptions,
      CFBundleIdentifier: input.appId,
      CFBundleDisplayName: input.label,
      CFBundleName: input.label,
    });
    return version;
  }

  private async writeIcons(app: string, backgroundColor: string): Promise<void> {
    for (const [size, scale] of [
      [120, 2],
      [180, 3],
    ]) {
      const png = await this.deps.icons.render({ backgroundColor }, size);
      await this.deps.files.writeFile(
        path.join(app, `PrototypeViewerIcon60x60@${scale}x.png`),
        png,
      );
    }
  }

  private async removeFailedStamp(temp: string): Promise<void> {
    try {
      await this.deps.files.rm(temp);
    } catch (error) {
      logger.warn("Could not remove temporary iOS disposable app directory", { temp, error });
    }
  }
}
