import { getDeviceDataStreamServer } from "../../daemon/streams/deviceDataStreamSocketServer";

export interface DeviceConnectionLostNotifier {
  onDeviceConnectionLost(deviceId: string): void;
}

export const observationStreamDeviceConnectionLostNotifier: DeviceConnectionLostNotifier = {
  onDeviceConnectionLost(deviceId: string): void {
    getDeviceDataStreamServer()?.onDeviceConnectionLost(deviceId);
  },
};
