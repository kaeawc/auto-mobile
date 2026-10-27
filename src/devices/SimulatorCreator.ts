import type { DeviceResourceConfiguration } from "../models/DeviceResourceConfiguration";
export interface SimulatorCreateRequest {
  name: string;
  deviceType: string;
  runtime: string;
  resources?: DeviceResourceConfiguration;
  signal?: AbortSignal;
}
export interface SimulatorCreator {
  create(request: SimulatorCreateRequest): Promise<{ udid: string; source: "clone" | "create" }>;
}
