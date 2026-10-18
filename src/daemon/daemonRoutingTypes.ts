import type { getPerformancePushServer } from "./performancePushSocketServer";
import type { getDeviceDataStreamServer } from "./deviceDataStreamSocketServer";
import type { PooledDevice } from "./devicePoolTypes";
import type { DevicePool } from "./devicePool";
import type { Session } from "./sessionManager";

type ResolverTarget = Pick<
  NonNullable<ReturnType<typeof getPerformancePushServer>>,
  "setDeviceSessionResolver"
>;

export type DeviceSessionRoutingTargets = {
  deviceDataStream: ReturnType<typeof getDeviceDataStreamServer>;
  performancePush: ResolverTarget | null;
  failuresPush: ResolverTarget | null;
  telemetryPush: ResolverTarget | null;
};

export interface CapturedDisconnectRecoveryOptions {
  deviceId: string;
  incidentId: string | undefined;
  pooledDevice: PooledDevice | null | undefined;
  sessionId: string | null | undefined;
  session: Session | null;
  forceGeneration: number | undefined;
  preparation?: ReturnType<DevicePool["prepareSessionPreservingRecovery"]>;
}
