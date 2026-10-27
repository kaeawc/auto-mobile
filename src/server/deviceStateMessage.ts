import type { DeviceStateResult } from "../features/utility/DeviceState";

/** One-line summary of a getDeviceState/setDeviceState result for the tool response message. */
export function deviceStateMessage(result: DeviceStateResult): string {
  if (!result.success) {
    return result.error ?? "Failed to read device state";
  }

  const sections = [
    doNotDisturbMessage(result),
    connectivityMessage(result),
    biometricsMessage(result),
    networkConditionMessage(result),
    sensorsMessage(result),
    screenLockMessage(result),
    powerMessage(result),
  ].filter((section): section is string => section !== undefined);
  return sections.length > 0 ? sections.join("; ") : "Read device state";
}

function doNotDisturbMessage(result: DeviceStateResult): string | undefined {
  if (!result.doNotDisturb?.supported) {
    return undefined;
  }
  const { enabled, mode } = result.doNotDisturb;
  return enabled === false ? "DND off" : mode ? `DND on (${mode})` : "DND on";
}

function connectivityMessage(result: DeviceStateResult): string | undefined {
  if (!result.connectivity?.supported) {
    return undefined;
  }
  const { airplaneMode, wifiEnabled, bluetoothEnabled, locationEnabled } = result.connectivity;
  const connectivity = [
    connectivityStateMessage("Wi-Fi", wifiEnabled),
    connectivityStateMessage("Bluetooth", bluetoothEnabled),
    connectivityStateMessage("Location", locationEnabled),
    connectivityStateMessage("Airplane", airplaneMode),
  ].filter((state): state is string => state !== undefined);
  return connectivity.length > 0 ? connectivity.join(", ") : undefined;
}

function connectivityStateMessage(name: string, enabled: boolean | undefined): string | undefined {
  return enabled === undefined ? undefined : `${name} ${enabled ? "on" : "off"}`;
}

function biometricsMessage(result: DeviceStateResult): string | undefined {
  const enrollment = result.biometrics?.supported ? result.biometrics.enrollment : undefined;
  return enrollment === undefined ? undefined : `Biometrics ${enrollment}`;
}

function networkConditionMessage(result: DeviceStateResult): string | undefined {
  const profile = result.networkCondition?.supported ? result.networkCondition.profile : undefined;
  return profile === undefined ? undefined : `Network ${profile}`;
}

function sensorsMessage(result: DeviceStateResult): string | undefined {
  const sensors = result.sensors?.supported ? result.sensors.sensors : undefined;
  return sensors === undefined ? undefined : `${sensors.length} emulator sensors read`;
}

function screenLockMessage(result: DeviceStateResult): string | undefined {
  const type = result.screenLock?.supported ? result.screenLock.type : undefined;
  return type === undefined ? undefined : `Screen lock ${type}`;
}

function powerMessage(result: DeviceStateResult): string | undefined {
  const power = result.power?.supported ? result.power : undefined;
  if (!power) {
    return undefined;
  }
  const parts = [
    power.battery ? `battery ${power.battery.level}% ${power.battery.charging}` : undefined,
    power.doze && power.doze.mode !== "off" ? `${power.doze.mode} Doze` : undefined,
    power.batterySaver ? "battery saver on" : undefined,
    power.dataSaver ? "data saver on" : undefined,
    power.thermal?.override ? `thermal ${power.thermal.status} (override)` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? `Power: ${parts.join(", ")}` : "Power read";
}
