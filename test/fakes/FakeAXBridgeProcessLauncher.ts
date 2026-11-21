import type {
  AXBridgeProcessHandle,
  AXBridgeProcessLauncher,
} from "../../src/utils/ios/AXBridgeProcessLauncher";
import { FakeAXBridgeTransport } from "./FakeAXBridgeTransport";

export class FakeAXBridgeProcessLauncher implements AXBridgeProcessLauncher {
  readonly launches: { deviceId: string; handle: AXBridgeProcessHandle; kills: number }[] = [];
  beforeReturn?: () => Promise<void>;
  async launch(deviceId: string): Promise<AXBridgeProcessHandle> {
    const launch = {
      deviceId,
      kills: 0,
      handle: {
        pid: 1000 + this.launches.length,
        transport: new FakeAXBridgeTransport(),
        kill: () => {
          launch.kills++;
        },
      },
    };
    this.launches.push(launch);
    await this.beforeReturn?.();
    return launch.handle;
  }
}
