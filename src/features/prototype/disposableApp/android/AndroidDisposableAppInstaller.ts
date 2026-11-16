import { ActionableError } from "../../../../models/ActionableError";
import { InspectPackageSigning } from "../../../observe/InspectPackageSigning";
import {
  type AdbClientFactory,
  defaultAdbClientFactory,
} from "../../../../utils/android-cmdline-tools/AdbClientFactory";
import type { PackageSigningInspection } from "../../../../models/PackageSigningInspection";
import type { AdbExecutor } from "../../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { outputLooksLikeShellFailure } from "../../../../utils/android-cmdline-tools/shellOutputHeuristics";
import { normalizeSignerSet } from "../../../../utils/signingIdentity";
import { ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS } from "../../../action/installAppTimeout";
import type { DisposableAppInstallation, DisposableAppInstaller } from "../DisposableAppManager";
import { assertDisposableAppId } from "../disposableAppId";
import {
  DISPOSABLE_APP_ANDROID_PERMISSIONS,
  type DisposableAppPermissionGrants,
} from "../disposableAppPermissions";

/** The read-only signing inspection (`InspectPackageSigning`) narrowed to one call. */
export interface DisposableAppSigningReader {
  execute(appId: string): Promise<PackageSigningInspection>;
}

/** The device commands one Android device needs; resolved per call from the device id. */
export interface AndroidDisposableAppDevice {
  adb: Pick<AdbExecutor, "execute">;
  signing: DisposableAppSigningReader;
}

/** adb and the signing inspection for an Android device id, on the shared adb client factory. */
export function androidDisposableAppDevices(
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
): (deviceId: string) => AndroidDisposableAppDevice {
  return (deviceId) => {
    const device = { name: deviceId, deviceId, platform: "android" as const };
    return {
      adb: adbFactory.create(device),
      signing: new InspectPackageSigning(device, adbFactory),
    };
  };
}

/**
 * Signer recorded for an installed package whose signers could not be read. It never equals a
 * host digest, so the manager refuses to remove a package it cannot attribute to this host.
 */
export const UNREADABLE_DISPOSABLE_APP_SIGNER = "unreadable";

function output(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

/** `adb install` and `adb uninstall` print `Success` on their own line, or `Failure [CODE]`. */
function requireSuccess(result: { stdout: string; stderr: string }, what: string): void {
  const text = output(result);
  const succeeded = text.split(/\r?\n/).some((line) => line.trim() === "Success");
  if (!succeeded || text.includes("Failure [")) {
    throw new ActionableError(`${what} failed: ${text || "no output from adb"}`);
  }
}

/** `pm grant`, `pm revoke` and `pm set-permission-flags` print nothing on success. */
function requireQuietShell(result: { stdout: string; stderr: string }, what: string): void {
  if (outputLooksLikeShellFailure(result.stdout, result.stderr)) {
    throw new ActionableError(`${what} failed: ${output(result)}`);
  }
}

function manifestPermissions(names: readonly string[]): string[] {
  return [...new Set(names.flatMap((name) => DISPOSABLE_APP_ANDROID_PERMISSIONS[name] ?? []))];
}

/**
 * Granting one name and denying another that shares a manifest permission (`microphone` and
 * `speech` both use RECORD_AUDIO) cannot both hold, so it is refused before any device write.
 */
function rejectSharedManifestConflicts(grants: DisposableAppPermissionGrants): void {
  const granted = new Map(
    grants.granted.flatMap((name) =>
      (DISPOSABLE_APP_ANDROID_PERMISSIONS[name] ?? []).map((permission) => [permission, name]),
    ),
  );
  for (const name of grants.denied) {
    const shared = (DISPOSABLE_APP_ANDROID_PERMISSIONS[name] ?? []).find((permission) =>
      granted.has(permission),
    );
    if (shared !== undefined) {
      throw new ActionableError(
        `Permissions ${granted.get(shared)} and ${name} share ${shared} on Android, so one cannot be granted while the other is denied. Put both in the same list.`,
      );
    }
  }
}

/**
 * Installs, grants, inspects and removes disposable prototype apps over adb (#14184). Every app id
 * is checked against the reserved prefix before a command runs, so a caller bug cannot reach a
 * package outside it. Denial revokes with the `user-fixed` flag, so the app reads the permission
 * as blocked and the system shows no dialog.
 */
export class AndroidDisposableAppInstaller implements DisposableAppInstaller {
  constructor(private readonly deviceFor: (deviceId: string) => AndroidDisposableAppDevice) {}

  async install(
    deviceId: string,
    appId: string,
    artifactPath: string,
    options: { reset: boolean },
  ): Promise<void> {
    assertDisposableAppId(appId);
    const { adb } = this.deviceFor(deviceId);
    // -r updates in place and keeps app storage; reset clears it once the new APK is in place.
    const installed = await adb.execute(["install", "-r", artifactPath], {
      timeoutMs: ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS,
    });
    requireSuccess(installed, `Installing ${appId} on ${deviceId}`);
    if (options.reset) {
      const cleared = await adb.execute(["shell", "pm", "clear", appId], { noRetry: true });
      requireSuccess(cleared, `Clearing the storage of ${appId} on ${deviceId}`);
    }
  }

  async applyPermissions(
    deviceId: string,
    appId: string,
    grants: DisposableAppPermissionGrants,
  ): Promise<void> {
    assertDisposableAppId(appId);
    rejectSharedManifestConflicts(grants);
    const { adb } = this.deviceFor(deviceId);
    for (const permission of manifestPermissions(grants.granted)) {
      const result = await adb.execute(["shell", "pm", "grant", appId, permission], {
        noRetry: true,
      });
      requireQuietShell(result, `Granting ${permission} to ${appId}`);
    }
    for (const permission of manifestPermissions(grants.denied)) {
      const revoked = await adb.execute(["shell", "pm", "revoke", appId, permission], {
        noRetry: true,
      });
      requireQuietShell(revoked, `Revoking ${permission} from ${appId}`);
      const fixed = await adb.execute(
        ["shell", "pm", "set-permission-flags", appId, permission, "user-set", "user-fixed"],
        { noRetry: true },
      );
      requireQuietShell(fixed, `Marking ${permission} denied for ${appId}`);
    }
  }

  async uninstall(deviceId: string, appId: string): Promise<void> {
    assertDisposableAppId(appId);
    const { adb } = this.deviceFor(deviceId);
    const result = await adb.execute(["uninstall", appId], {
      timeoutMs: ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS,
    });
    requireSuccess(result, `Uninstalling ${appId} from ${deviceId}`);
  }

  async installedIds(deviceId: string, prefix: string): Promise<string[]> {
    const { adb } = this.deviceFor(deviceId);
    // pm treats the trailing argument as a substring filter; the prefix check below is exact.
    const result = await adb.execute(["shell", "pm", "list", "packages", prefix], {
      noRetry: true,
    });
    if (outputLooksLikeShellFailure(result.stdout, result.stderr)) {
      throw new ActionableError(
        `Listing packages on ${deviceId} failed: ${output(result)}. Check that the device is online and retry.`,
      );
    }
    const ids = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("package:"))
      .map((line) => line.slice("package:".length).trim())
      .filter((appId) => appId.startsWith(prefix));
    return [...new Set(ids)].sort();
  }

  async inspect(deviceId: string, appId: string): Promise<DisposableAppInstallation> {
    assertDisposableAppId(appId);
    const inspection = await this.deviceFor(deviceId).signing.execute(appId);
    if (inspection.presence === "unknown") {
      throw new ActionableError(
        `Cannot tell whether ${appId} is installed on ${deviceId}: ${inspection.unknownReason ?? "package presence is unknown"}. Nothing was removed; retry once the device answers.`,
      );
    }
    if (inspection.presence === "absent") {
      return { installed: false };
    }
    const signing = inspection.signing;
    // A package signed by several keys is identified by the whole set, which a single host key
    // never matches; an unreadable set is never attributed to this host either.
    const signer =
      signing.status === "available"
        ? normalizeSignerSet(signing.signerSha256).join(",")
        : UNREADABLE_DISPOSABLE_APP_SIGNER;
    return { installed: true, signer };
  }
}
