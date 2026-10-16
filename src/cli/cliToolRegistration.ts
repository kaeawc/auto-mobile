import { installDefaultProvisionedDeviceTransportFence } from "../db/createDefaultProvisionedDeviceTransportFence";
import { registerAllTools } from "../server/registerAllTools";

// Initialize tool registry for CLI mode
export function initializeCliTools(): void {
  installDefaultProvisionedDeviceTransportFence();
  registerAllTools({ daemonMode: true, includeDoctor: true, includeToolSelection: false });
}
