import type {
  DisposableAppInstallation,
  DisposableAppInstaller,
} from "../../src/features/prototype/disposableApp/DisposableAppManager";
import type { DisposableAppPermissionGrants } from "../../src/features/prototype/disposableApp/disposableAppPermissions";

/** A device's installed packages keyed by `deviceId/appId`, with each one's signer. */
export class FakeDisposableAppInstaller implements DisposableAppInstaller {
  readonly packages = new Map<string, string | undefined>();
  readonly installs: { deviceId: string; artifactPath: string; reset: boolean }[] = [];
  readonly grants: { appId: string; grants: DisposableAppPermissionGrants }[] = [];
  readonly uninstalls: string[] = [];

  constructor(private readonly signer: string | undefined = "host-key") {}

  /** Seed a package, for example one signed by a foreign key. */
  seed(deviceId: string, appId: string, signer: string | undefined): void {
    this.packages.set(`${deviceId}/${appId}`, signer);
  }

  async install(deviceId: string, artifactPath: string, options: { reset: boolean }) {
    this.installs.push({ deviceId, artifactPath, reset: options.reset });
    const appId = artifactPath.replace(/^\/stamped\//, "").replace(/\.apk$/, "");
    this.packages.set(`${deviceId}/${appId}`, this.signer);
  }

  async applyPermissions(_deviceId: string, appId: string, grants: DisposableAppPermissionGrants) {
    this.grants.push({ appId, grants });
  }

  async uninstall(deviceId: string, appId: string): Promise<void> {
    this.uninstalls.push(appId);
    this.packages.delete(`${deviceId}/${appId}`);
  }

  async installedIds(deviceId: string, prefix: string): Promise<string[]> {
    return [...this.packages.keys()]
      .filter((key) => key.startsWith(`${deviceId}/`))
      .map((key) => key.slice(deviceId.length + 1))
      .filter((appId) => appId.startsWith(prefix));
  }

  async inspect(deviceId: string, appId: string): Promise<DisposableAppInstallation> {
    const key = `${deviceId}/${appId}`;
    return this.packages.has(key)
      ? { installed: true, signer: this.packages.get(key) }
      : { installed: false };
  }
}
