import type { DeviceExecutionBinding } from "../../src/server/deviceExecutionBinding";
import type { AmbientExecutionIdReader } from "../../src/utils/interfaces/AmbientExecutionIdReader";

export class FakeDeviceExecutionBinding
  implements DeviceExecutionBinding, AmbientExecutionIdReader
{
  readonly deviceIds: string[] = [];
  executionId?: string;

  getExecutionId(): string | undefined {
    return this.executionId;
  }

  bindDeviceExecution(deviceId: string): void {
    this.deviceIds.push(deviceId);
  }
}
