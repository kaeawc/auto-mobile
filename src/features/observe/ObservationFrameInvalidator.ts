import { getDeviceDataStreamServer } from "../../daemon/deviceDataStreamSocketServer";

export interface ObservationFrameInvalidator {
  invalidateDeviceFrames(deviceId: string): void;
}

export const observationStreamFrameInvalidator: ObservationFrameInvalidator = {
  invalidateDeviceFrames(deviceId: string): void {
    getDeviceDataStreamServer()?.invalidateDeviceFrames(deviceId);
  },
};
