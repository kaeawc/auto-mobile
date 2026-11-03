import { createHash } from "node:crypto";
import { ActionableError } from "../../../models/ActionableError";
import type { Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import type { PrototypeJson } from "../prototypeJson";
import {
  assertDisposableAppId,
  DISPOSABLE_APP_ID_PREFIX,
  disposableAppId,
  type DisposableAppPlatform,
} from "./disposableAppId";
import {
  type DisposableAppDeclarations,
  disposableAppDeclarations,
  type DisposableAppPermissionGrants,
  type DisposableAppPermissionMode,
  resolveDisposableAppGrants,
} from "./disposableAppPermissions";
import type { DisposableAppRecord, DisposableAppRegistry } from "./DisposableAppRegistry";
import { type DisposableAppTemplate, selectDisposableAppTemplate } from "./disposableAppTemplates";

/**
 * Host side of disposable prototype apps (#14184): install a spec as its own app, list the apps
 * the host installed, and uninstall or expire them. Stamping (#14185 Android, #14186 iOS) and
 * device commands sit behind the injected per-platform `DisposableAppStamper` and
 * `DisposableAppInstaller`, so this module is platform-neutral and unit-tested with fakes.
 */

export const DEFAULT_DISPOSABLE_APP_TTL_HOURS = 72;
export const MAX_DISPOSABLE_APP_TTL_HOURS = 24 * 30;
const HOUR_MS = 60 * 60 * 1000;

export type DisposableAppIcon = { asset: string } | { backgroundColor: string };

export interface DisposableAppStampInput {
  appId: string;
  slug: string;
  label: string;
  icon?: DisposableAppIcon;
  spec: PrototypeJson;
  template: DisposableAppTemplate;
  declarations: DisposableAppDeclarations;
}

export interface DisposableAppStamped {
  /** Host path of the stamped APK or app bundle. */
  artifactPath: string;
  version: string;
}

export interface DisposableAppStamper {
  templates(): Promise<readonly DisposableAppTemplate[]>;
  /** Digest of the host's disposable-app signing key; installed apps must match it. */
  signer(): Promise<string>;
  stamp(input: DisposableAppStampInput): Promise<DisposableAppStamped>;
}

export interface DisposableAppInstallation {
  installed: boolean;
  /** Signer digest of the installed app, when the platform reports one. */
  signer?: string;
}

export interface DisposableAppInstaller {
  /** Installs or updates in place; `reset` clears app storage first. */
  install(deviceId: string, artifactPath: string, options: { reset: boolean }): Promise<void>;
  applyPermissions(
    deviceId: string,
    appId: string,
    grants: DisposableAppPermissionGrants,
  ): Promise<void>;
  uninstall(deviceId: string, appId: string): Promise<void>;
  /** Installed application ids that start with `prefix`. */
  installedIds(deviceId: string, prefix: string): Promise<string[]>;
  inspect(deviceId: string, appId: string): Promise<DisposableAppInstallation>;
}

export interface DisposableAppPlatformSupport {
  stamper: DisposableAppStamper;
  installer: DisposableAppInstaller;
}

export interface DisposableAppManagerDependencies {
  platforms: Partial<Record<DisposableAppPlatform, DisposableAppPlatformSupport>>;
  registry: DisposableAppRegistry;
  timer: Pick<Timer, "now">;
}

export interface DisposableAppInstallInput {
  deviceId: string;
  platform: DisposableAppPlatform;
  spec: PrototypeJson;
  app: {
    slug: string;
    label: string;
    icon?: DisposableAppIcon;
    /** Hours until the app expires; 0 keeps it until uninstalled. */
    ttlHours?: number;
    permissions?: DisposableAppPermissionMode;
    reset?: boolean;
  };
}

export interface DisposableAppInstallResult {
  appId: string;
  platform: DisposableAppPlatform;
  label: string;
  version: string;
  expiresAt: string | null;
  template: string;
  permissions: { declared: string[]; granted: string[]; denied: string[] };
  /** True when the slug was already installed and was updated in place. */
  updated: boolean;
  launched: false;
}

export interface DisposableAppListEntry {
  appId: string;
  /** Recorded in this host's registry. */
  registered: boolean;
  /** Present on the device. */
  installed: boolean;
  expired: boolean;
  slug?: string;
  label?: string;
  template?: string;
  installedAt?: string;
  expiresAt?: string | null;
}

export type DisposableAppUninstallTarget = { appId: string } | { all: true } | { expired: true };

export interface DisposableAppRemoval {
  appId: string;
  reason: string;
}

export interface DisposableAppUninstallResult {
  removed: DisposableAppRemoval[];
  skipped: DisposableAppRemoval[];
}

function isoOrNull(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

function ttlMs(ttlHours: number | undefined): number | null {
  const hours = ttlHours ?? DEFAULT_DISPOSABLE_APP_TTL_HOURS;
  if (!Number.isInteger(hours) || hours < 0 || hours > MAX_DISPOSABLE_APP_TTL_HOURS) {
    throw new ActionableError(
      `app.ttlHours must be an integer from 0 to ${MAX_DISPOSABLE_APP_TTL_HOURS} (0 keeps the app until uninstallApp); got ${String(ttlHours)}.`,
    );
  }
  return hours === 0 ? null : hours * HOUR_MS;
}

export class DisposableAppManager {
  constructor(private readonly deps: DisposableAppManagerDependencies) {}

  async install(input: DisposableAppInstallInput): Promise<DisposableAppInstallResult> {
    const { stamper, installer } = this.support(input.platform);
    const appId = disposableAppId(input.platform, input.app.slug);
    const lifetime = ttlMs(input.app.ttlHours);
    const declarations = disposableAppDeclarations(input.spec);
    const grants = resolveDisposableAppGrants(
      input.app.permissions ?? "prompt",
      declarations.permissions,
    );
    const template = selectDisposableAppTemplate(input.spec, await stamper.templates());
    const existing = (await this.deps.registry.list(input.deviceId)).some(
      (record) => record.appId === appId,
    );
    const stamped = await stamper.stamp({
      appId,
      slug: input.app.slug,
      label: input.app.label,
      icon: input.app.icon,
      spec: input.spec,
      template,
      declarations,
    });
    await installer.install(input.deviceId, stamped.artifactPath, {
      reset: input.app.reset === true,
    });
    await installer.applyPermissions(input.deviceId, appId, grants);
    const installedAt = this.deps.timer.now();
    const expiresAt = lifetime === null ? null : installedAt + lifetime;
    await this.deps.registry.put(input.deviceId, {
      appId,
      slug: input.app.slug,
      platform: input.platform,
      label: input.app.label,
      specSha256: createHash("sha256").update(JSON.stringify(input.spec)).digest("hex"),
      template: template.name,
      signer: await stamper.signer(),
      installedAt,
      expiresAt,
    });
    return {
      appId,
      platform: input.platform,
      label: input.app.label,
      version: stamped.version,
      expiresAt: isoOrNull(expiresAt),
      template: template.name,
      permissions: { declared: declarations.permissions, ...grants },
      updated: existing,
      launched: false,
    };
  }

  /** The host registry joined with the device's packages under the reserved prefix. */
  async list(deviceId: string, platform: DisposableAppPlatform): Promise<DisposableAppListEntry[]> {
    const { installer } = this.support(platform);
    const records = await this.platformRecords(deviceId, platform);
    const installed = new Set(await installer.installedIds(deviceId, DISPOSABLE_APP_ID_PREFIX));
    const now = this.deps.timer.now();
    const fromRegistry = records.map((record) => ({
      appId: record.appId,
      registered: true,
      installed: installed.has(record.appId),
      expired: this.isExpired(record, now),
      slug: record.slug,
      label: record.label,
      template: record.template,
      installedAt: new Date(record.installedAt).toISOString(),
      expiresAt: isoOrNull(record.expiresAt),
    }));
    const known = new Set(records.map((record) => record.appId));
    const unregistered = [...installed]
      .filter((appId) => !known.has(appId))
      .map((appId) => ({ appId, registered: false, installed: true, expired: false }));
    return [...fromRegistry, ...unregistered].sort((a, b) => a.appId.localeCompare(b.appId));
  }

  async uninstall(
    deviceId: string,
    platform: DisposableAppPlatform,
    target: DisposableAppUninstallTarget,
  ): Promise<DisposableAppUninstallResult> {
    if ("appId" in target) {
      assertDisposableAppId(target.appId);
      const refusal = await this.removeOne(deviceId, platform, target.appId, "requested");
      if (refusal) {
        throw new ActionableError(refusal);
      }
      return { removed: [{ appId: target.appId, reason: "requested" }], skipped: [] };
    }
    const [ids, reason] =
      "all" in target
        ? [(await this.list(deviceId, platform)).map((entry) => entry.appId), "all"]
        : [await this.expiredIds(deviceId, platform), "expired"];
    const result: DisposableAppUninstallResult = { removed: [], skipped: [] };
    for (const appId of ids) {
      const refusal = await this.removeOne(deviceId, platform, appId, reason);
      (refusal ? result.skipped : result.removed).push({ appId, reason: refusal ?? reason });
    }
    return result;
  }

  /** The TTL sweep run when a session acquires the device, and by `uninstallApp {expired}`. */
  async sweepExpired(
    deviceId: string,
    platform: DisposableAppPlatform,
  ): Promise<DisposableAppUninstallResult> {
    return this.uninstall(deviceId, platform, { expired: true });
  }

  private support(platform: DisposableAppPlatform): DisposableAppPlatformSupport {
    const support = this.deps.platforms[platform];
    if (!support) {
      throw new ActionableError(
        `Disposable prototype apps are not available on ${platform} yet: this host has no ${platform} app stamper. Use prototype show or save instead.`,
      );
    }
    return support;
  }

  private async platformRecords(
    deviceId: string,
    platform: DisposableAppPlatform,
  ): Promise<DisposableAppRecord[]> {
    return (await this.deps.registry.list(deviceId)).filter(
      (record) => record.platform === platform,
    );
  }

  private isExpired(record: DisposableAppRecord, now: number): boolean {
    return record.expiresAt !== null && record.expiresAt <= now;
  }

  private async expiredIds(deviceId: string, platform: DisposableAppPlatform): Promise<string[]> {
    const now = this.deps.timer.now();
    return (await this.platformRecords(deviceId, platform))
      .filter((record) => this.isExpired(record, now))
      .map((record) => record.appId);
  }

  /** Removes one app; resolves a refusal message instead of removing a foreign-signed package. */
  private async removeOne(
    deviceId: string,
    platform: DisposableAppPlatform,
    appId: string,
    reason: string,
  ): Promise<string | undefined> {
    const { stamper, installer } = this.support(platform);
    const installation = await installer.inspect(deviceId, appId);
    if (installation.installed && installation.signer !== undefined) {
      const expected = await stamper.signer();
      if (installation.signer !== expected) {
        return `${appId} on ${deviceId} is not signed by this host's disposable-app key, so it was not removed. Remove it with the uninstallApp tool if it is yours.`;
      }
    }
    if (installation.installed) {
      await installer.uninstall(deviceId, appId);
    }
    await this.deps.registry.remove(deviceId, appId);
    logger.warn(`Removed disposable prototype app ${appId} from ${deviceId} (${reason}).`);
    return undefined;
  }
}
