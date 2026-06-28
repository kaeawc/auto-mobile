import { getDeviceDataStreamServer } from "../../daemon/deviceDataStreamSocketServer";

export interface DeviceConnectionLostNotifier {
  onDeviceConnectionLost(deviceId: string): void;
}

export const observationStreamDeviceConnectionLostNotifier: DeviceConnectionLostNotifier = {
  onDeviceConnectionLost(deviceId: string): void {
    getDeviceDataStreamServer()?.onDeviceConnectionLost(deviceId);
  },
};
