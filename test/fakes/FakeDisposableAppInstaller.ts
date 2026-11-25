import type {
  DisposableAppInstallation,
  DisposableAppInstaller,
} from "../../src/features/prototype/disposableApp/DisposableAppManager";
import type { DisposableAppPermissionPlan } from "../../src/features/prototype/disposableApp/disposableAppPermissions";
import type { PrototypePermissionResult } from "../../src/features/prototype/prototypePermissionGrants";
import {
  PROTOTYPE_PERMISSION_NAMES,
  type PrototypePermissionName,
} from "../../src/features/prototype/prototypePermissionMap";

function canonical(name: string): PrototypePermissionName {
  const found = PROTOTYPE_PERMISSION_NAMES.find((candidate) => candidate === name);
  if (found === undefined) {
    throw new Error(`FakeDisposableAppInstaller: ${name} is not a prototype permission name`);
  }
  return found;
}

/** What a device reads back after the plan ran: denied names are user-fixed on Android. */
function readBack(plan: DisposableAppPermissionPlan): PrototypePermissionResult[] {
  return plan.declared.map((name) => ({
    name: canonical(name),
    state: plan.granted.includes(name)
      ? "granted"
      : plan.denied.includes(name)
        ? "blocked"
        : "notDetermined",
    verified: true,
  }));
}

/** A device's installed packages keyed by `deviceId/appId`, with each one's signer. */
export class FakeDisposableAppInstaller implements DisposableAppInstaller {
  readonly packages = new Map<string, string | undefined>();
  readonly installs: { deviceId: string; artifactPath: string }[] = [];
  readonly seeds: { appId: string; artifactPath: string }[] = [];
  readonly resets: string[] = [];
  readonly grants: { appId: string; plan: DisposableAppPermissionPlan }[] = [];
  readonly uninstalls: string[] = [];

  /** When set, `seedStorage` rejects with it after recording the seed. */
  seedFailure: Error | undefined;
  /** Called as `seedStorage` starts, for example to check the artifact still exists. */
  onSeed: ((appId: string, artifactPath: string) => Promise<void>) | undefined;
  /** When set, `resetStorage` rejects with it after recording the reset. */
  resetFailure: Error | undefined;
  /** When set, `applyPermissions` rejects with it after recording the grants. */
  permissionFailure: Error | undefined;
  /** When set, `inspect` waits for it, so a test can interleave another operation. */
  inspectGate: Promise<void> | undefined;
  /** Called as `inspect` starts, before it waits on `inspectGate`. */
  onInspect: (() => void) | undefined;
  /** Called as `uninstall` runs, for example to advance a FakeTimer by the command's duration. */
  onUninstall: ((appId: string) => void) | undefined;

  constructor(private readonly signer: string | undefined = "host-key") {}

  /** Seed a package, for example one signed by a foreign key. */
  seed(deviceId: string, appId: string, signer: string | undefined): void {
    this.packages.set(`${deviceId}/${appId}`, signer);
  }

  async install(deviceId: string, appId: string, artifactPath: string) {
    this.installs.push({ deviceId, artifactPath });
    this.packages.set(`${deviceId}/${appId}`, this.signer);
  }

  async seedStorage(_deviceId: string, appId: string, artifactPath: string) {
    await this.onSeed?.(appId, artifactPath);
    this.seeds.push({ appId, artifactPath });
    if (this.seedFailure) {
      throw this.seedFailure;
    }
  }

  async resetStorage(_deviceId: string, appId: string) {
    this.resets.push(appId);
    if (this.resetFailure) {
      throw this.resetFailure;
    }
  }

  async applyPermissions(_deviceId: string, appId: string, plan: DisposableAppPermissionPlan) {
    this.grants.push({ appId, plan });
    if (this.permissionFailure) {
      throw this.permissionFailure;
    }
    return readBack(plan);
  }

  async uninstall(deviceId: string, appId: string): Promise<void> {
    this.uninstalls.push(appId);
    this.onUninstall?.(appId);
    this.packages.delete(`${deviceId}/${appId}`);
  }

  async installedIds(deviceId: string, prefix: string): Promise<string[]> {
    return [...this.packages.keys()]
      .filter((key) => key.startsWith(`${deviceId}/`))
      .map((key) => key.slice(deviceId.length + 1))
      .filter((appId) => appId.startsWith(prefix));
  }

  async inspect(deviceId: string, appId: string): Promise<DisposableAppInstallation> {
    this.onInspect?.();
    await this.inspectGate;
    const key = `${deviceId}/${appId}`;
    return this.packages.has(key)
      ? { installed: true, signer: this.packages.get(key) }
      : { installed: false };
  }
}
