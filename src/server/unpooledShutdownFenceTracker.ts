import type { DevicePool } from "../daemon/devicePool";

type FencePool = Pick<DevicePool, "clearUnpooledShutdown" | "settleUnpooledShutdown">;
type RetainShutdown = (operation: Promise<unknown>, releaseAfterFailure?: boolean) => void;

/** Pair an opted-in unpooled shutdown with its final or retained settlement. */
export function createUnpooledFenceTracker(pool: FencePool | undefined, deviceId: string) {
  let retained = 0;
  const clear = () => pool?.clearUnpooledShutdown(deviceId);
  const settle = () => {
    if (retained === 0) {
      pool?.settleUnpooledShutdown(deviceId);
    }
  };
  const release = () => {
    retained--;
    settle();
  };
  return {
    clear,
    settle,
    wrapRetain: (retain: RetainShutdown): RetainShutdown => {
      if (!pool) {
        return retain;
      }
      return (operation, releaseAfterFailure) => {
        retained++;
        retain(
          operation.then(
            (value) => {
              release();
              return value;
            },
            (error) => {
              release();
              throw error;
            },
          ),
          releaseAfterFailure,
        );
      };
    },
  };
}
