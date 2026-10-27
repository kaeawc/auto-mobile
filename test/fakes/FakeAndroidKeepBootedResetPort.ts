import type { AndroidKeepBootedResetPort } from "../../src/daemon/sessionBroker/androidKeepBootedReset";
import { diffDeviceBaseline } from "../../src/daemon/sessionBroker/mutations/baseline";
import type { DeviceMutationResetContext } from "../../src/daemon/sessionBroker/mutations/reset";
import type { DeviceBaseline } from "../../src/daemon/sessionBroker/mutations/types";
import { FakeDeviceMutationResetPort } from "./FakeDeviceMutationResetPort";

export class FakeAndroidKeepBootedResetPort
  extends FakeDeviceMutationResetPort
  implements AndroidKeepBootedResetPort
{
  cleanCount = 0;
  beforeClean: (() => Promise<void>) | null = null;

  async cleanBaseline(
    baseline: DeviceBaseline,
    context: DeviceMutationResetContext,
  ): Promise<void> {
    await this.beforeClean?.();
    await context.assertOwned();
    this.cleanCount++;
    for (const change of diffDeviceBaseline(baseline, this.snapshot).changes) {
      const mutation = {
        kind: change.kind,
        key: change.key,
        priorValue: change.priorValue,
        toolName: "keep-booted-cleaning",
      };
      if (
        ["installed-app", "permission", "device-setting", "shared-file"].includes(change.kind) &&
        this.canRevert(mutation)
      ) {
        await this.revert(mutation, context);
      }
    }
  }
}
