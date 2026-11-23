import { registerDeviceIncarnationListener } from "../../utils/deviceIncarnation";
import type { DisplayTheme } from "./displayConfigTypes";

/** Process-lifetime baseline for the first night-mode value this tool replaces. */
export interface ThemeBaselineStore {
  get(deviceId: string): DisplayTheme | undefined;
  set(deviceId: string, theme: DisplayTheme): void;
  delete(deviceId: string): void;
}

export const defaultThemeBaselines: ThemeBaselineStore = new Map<string, DisplayTheme>();

registerDeviceIncarnationListener({
  name: "android-display-config-theme-baselines",
  onDeviceIdentityReplaced: (deviceId) => defaultThemeBaselines.delete(deviceId),
  // Snapshot restore and same-device re-pool retain guest night-mode state and its baseline.
  onDeviceIncarnationChanged: () => {},
});
