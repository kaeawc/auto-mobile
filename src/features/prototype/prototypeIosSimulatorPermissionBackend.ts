import { ActionableError } from "../../models/ActionableError";
import type { IosPermissionsBackend } from "../../utils/ios-cmdline-tools/IosPermissionsBackend";
import type {
  TccPermissionReader,
  TccPermissionRow,
} from "../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";
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
 * iOS simulator half of #14297: `simctl privacy grant|revoke` and a TCC read. The planner never
 * writes a notGrantableOnSimulator name; its read reports `notDetermined` because the host has
 * no TCC row for it, and the planner marks the result unverified.
 */
export class IosSimulatorPrototypePermissionBackend implements PrototypePermissionBackend {
  readonly target = "iosSimulator";

  constructor(
    private readonly privacy: Pick<IosPermissionsBackend, "setPrivacy">,
    private readonly tcc: TccPermissionReader,
    private readonly options: { deviceId: string; bundleId: string },
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
