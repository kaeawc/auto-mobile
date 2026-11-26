import { ActionableError } from "../../models/ActionableError";
import type { IosPermissionsBackend } from "../../utils/ios-cmdline-tools/IosPermissionsBackend";
import type {
  TccPermissionReader,
  TccPermissionRow,
} from "../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import type { SimulatorLocationAuthorizationReader } from "../../utils/ios-cmdline-tools/SimulatorLocationdClients";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import type { PrototypePermissionBackend } from "./prototypePermissionGrants";
import type {
  PrototypePermissionMapping,
  PrototypePermissionName,
  PrototypePermissionState,
} from "./prototypePermissionMap";

/** TCC `auth_value` (0 denied, 2 allowed, 3 limited), falling back to the legacy `allowed` column. */
function iosStateFromRow(row: TccPermissionRow | undefined): PrototypePermissionState {
  const value = row?.auth_value ?? (row?.allowed === 1 ? 2 : row?.allowed);
  if (value === 2) {
    return "granted";
  }
  if (value === 3) {
    return "limited";
  }
  return value === 0 ? "denied" : "notDetermined";
}

/**
 * locationd's `Authorization` after `simctl privacy` (captured on iOS 27.2, #19370): `grant
 * location` writes 2 (when in use), `grant location-always` writes 4, `revoke` writes 1, and
 * `reset` removes it. When-in-use alone leaves the always request undecided.
 */
function iosLocationState(service: string, value: number | null): PrototypePermissionState {
  if (value === 1) {
    return "denied";
  }
  if (value === 4 || (value === 2 && service === "location")) {
    return "granted";
  }
  return "notDetermined";
}

/** The `simctl privacy` services the simulator records in locationd, not TCC.db. */
const LOCATIOND_SERVICES = new Set(["location", "location-always"]);

/**
 * iOS simulator half of #14297: `simctl privacy grant|revoke` and a TCC read. The planner never
 * writes a notGrantableOnSimulator name; its read reports `notDetermined` because the host has
 * no TCC row for it, and the planner marks the result unverified. Location reads back from
 * locationd's clients.plist, where the simulator keeps it.
 */
export class IosSimulatorPrototypePermissionBackend implements PrototypePermissionBackend {
  readonly target = "iosSimulator";

  constructor(
    private readonly privacy: Pick<IosPermissionsBackend, "setPrivacy">,
    private readonly tcc: TccPermissionReader,
    private readonly options: { deviceId: string; bundleId: string },
    private readonly location: SimulatorLocationAuthorizationReader,
  ) {}

  grant(name: PrototypePermissionName, mapping: PrototypePermissionMapping): Promise<void> {
    return this.setPrivacy("grant", name, mapping);
  }

  deny(name: PrototypePermissionName, mapping: PrototypePermissionMapping): Promise<void> {
    return this.setPrivacy("revoke", name, mapping);
  }

  async read(
    _name: PrototypePermissionName,
    mapping: PrototypePermissionMapping,
  ): Promise<PrototypePermissionState> {
    const service = mapping.ios.simctlService;
    if (service === null) {
      return "notDetermined";
    }
    if (LOCATIOND_SERVICES.has(service)) {
      const value = await this.location.readLocationAuthorization(
        this.options.deviceId,
        this.options.bundleId,
      );
      return iosLocationState(service, value);
    }
    const rows = await this.tcc.readPermissions(this.options.deviceId, this.options.bundleId, [
      service,
    ]);
    return iosStateFromRow(rows[0]);
  }

  private async setPrivacy(
    action: "grant" | "revoke",
    name: PrototypePermissionName,
    mapping: PrototypePermissionMapping,
  ): Promise<void> {
    const service = mapping.ios.simctlService;
    if (service === null) {
      throw new ActionableError(
        `Permission ${name} has no simctl privacy service, so a simulator cannot ${action} it`,
      );
    }
    const result = await this.privacy.setPrivacy({
      action,
      permission: service,
      appId: this.options.bundleId,
    });
    if (outputLooksLikeShellFailure(result.stdout, result.stderr ?? "")) {
      throw new ActionableError(
        `\`simctl privacy ${action} ${service}\` failed: ${`${result.stdout}\n${result.stderr ?? ""}`.trim()}`,
      );
    }
  }
}
