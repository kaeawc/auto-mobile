import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import mapping from "../../../schemas/prototype-platform-permissions.json";
import {
  notGrantableOnSimulator,
  PROTOTYPE_PERMISSION_MAP,
  PROTOTYPE_PERMISSION_NAMES,
} from "../../../src/features/prototype/prototypePermissionMap";
import { tccServiceForPermission } from "../../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";

describe("prototype permission mapping", () => {
  test("maps exactly the canonical names, in contract order", () => {
    expect(Object.keys(mapping)).toEqual([...PROTOTYPE_PERMISSION_NAMES]);
    expect(Object.keys(contract.platformModules.permissions.state)).toEqual([
      ...PROTOTYPE_PERMISSION_NAMES,
    ]);
    expect(contract.platformModules.permissions.calls.request.args.names.value.item.values).toEqual(
      [...PROTOTYPE_PERMISSION_NAMES],
    );
  });

  test("every simctl service is one simctl privacy accepts", () => {
    for (const name of PROTOTYPE_PERMISSION_NAMES) {
      const service = PROTOTYPE_PERMISSION_MAP[name].ios.simctlService;
      if (service !== null) {
        expect(tccServiceForPermission(service)).toStartWith("kTCCService");
      }
    }
  });

  test("notifications and Bluetooth are not grantable on a simulator", () => {
    expect(notGrantableOnSimulator("notifications")).toBe(true);
    expect(notGrantableOnSimulator("bluetooth")).toBe(true);
    expect(notGrantableOnSimulator("camera")).toBe(false);
  });

  test("Android notifications use the notification setting, not pm grant", () => {
    expect(PROTOTYPE_PERMISSION_MAP.notifications.android).toEqual({
      manifest: ["android.permission.POST_NOTIFICATIONS"],
      grant: "notifications",
    });
  });

  test("every runtime-granted Android entry names at least one manifest permission", () => {
    for (const name of PROTOTYPE_PERMISSION_NAMES) {
      const android = PROTOTYPE_PERMISSION_MAP[name].android;
      expect(android.grant === "none" || android.manifest.length > 0).toBe(true);
    }
  });
});
