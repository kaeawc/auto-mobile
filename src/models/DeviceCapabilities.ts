export interface DeviceCapabilities {
  refreshRate: number; // Hz (60, 90, 120, etc.)
  frameTimeMs: number; // Target frame time in ms (16.67 for 60Hz, 8.33 for 120Hz)
}
