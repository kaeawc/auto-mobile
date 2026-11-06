import { createHash } from "node:crypto";
import { join } from "node:path";
import { ENV } from "../../../../config/env";
import { ActionableError, toActionableError } from "../../../../models/ActionableError";
import { DefaultFileSystem, type FileSystem } from "../../../../utils/filesystem/DefaultFileSystem";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../../../utils/workingDirectory";
import type { DisposableAppTemplate } from "../disposableAppTemplates";

export interface AndroidDisposableAppTemplate extends DisposableAppTemplate {
  apkPath: string;
  manifestXml: string;
  templatePackage: string;
  apkSha256: string;
}
export function asDisposableAppTemplate(
  template: AndroidDisposableAppTemplate,
): DisposableAppTemplate {
  return template;
}
export interface AndroidDisposableAppTemplateSource {
  resolve(flavor?: string): Promise<AndroidDisposableAppTemplate>;
}
export class AndroidDisposableAppTemplateProvider implements AndroidDisposableAppTemplateSource {
  constructor(
    private readonly fs: FileSystem = new DefaultFileSystem(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  async resolve(flavor = "base"): Promise<AndroidDisposableAppTemplate> {
    const configured = this.env[ENV.ANDROID_PROTOTYPE_APP_TEMPLATE.name];
    if (!configured) {
      throw new ActionableError(
        "The Android template release asset is not published yet. Set AUTOMOBILE_ANDROID_PROTOTYPE_APP_TEMPLATE to a packaged template directory.",
      );
    }
    if (!/^[a-z][a-z0-9-]*$/.test(flavor)) {
      throw new ActionableError("Invalid Android template flavor.");
    }
    try {
      const root = resolvePathFromDaemonLaunchWorkingDirectory(configured, this.env);
      const directory = (await this.fs.pathExists(join(root, "template.json")))
        ? root
        : join(root, flavor);
      const metadata: unknown = JSON.parse(
        await this.fs.readFile(join(directory, "template.json")),
      );
      const caps: unknown = JSON.parse(
        await this.fs.readFile(join(directory, "capabilities.json")),
      );
      if (!isMetadata(metadata) || metadata.template !== flavor || !isCapabilities(caps)) {
        throw new ActionableError(
          "Invalid Android template metadata or flavor. Repackage the template.",
        );
      }
      const apkPath = join(directory, "template.apk");
      const bytes = await this.fs.readFileBuffer(apkPath);
      const apkSha256 = createHash("sha256").update(bytes).digest("hex");
      if (apkSha256 !== metadata.apkSha256) {
        throw new ActionableError(
          "Android template APK checksum mismatch. Repackage the template.",
        );
      }
      return {
        apkPath,
        apkSha256,
        templatePackage: metadata.applicationId,
        name: metadata.template,
        capabilities: caps.capabilities,
        size: bytes.length,
        manifestXml: await this.fs.readFile(join(directory, "AndroidManifest.xml")),
      };
    } catch (error) {
      throw toActionableError(
        error,
        "Cannot load Android template; check AUTOMOBILE_ANDROID_PROTOTYPE_APP_TEMPLATE",
      );
    }
  }
}
function isMetadata(
  value: unknown,
): value is { template: string; applicationId: string; apkSha256: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "template" in value &&
    typeof value.template === "string" &&
    "applicationId" in value &&
    typeof value.applicationId === "string" &&
    "apkSha256" in value &&
    typeof value.apkSha256 === "string"
  );
}
function isCapabilities(value: unknown): value is { capabilities: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "capabilities" in value &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((entry: unknown) => typeof entry === "string")
  );
}
