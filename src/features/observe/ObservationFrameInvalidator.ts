import { getDeviceDataStreamServer } from "../../daemon/streams/deviceDataStreamSocketServer";

export interface ObservationFrameInvalidator {
  invalidateDeviceFrames(deviceId: string): void;
}

export const observationStreamFrameInvalidator: ObservationFrameInvalidator = {
  invalidateDeviceFrames(deviceId: string): void {
    getDeviceDataStreamServer()?.invalidateDeviceFrames(deviceId);
  },
};
