import { z } from "zod/v4";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { defineDeviceTool, type DeviceToolHandler } from "./defineTool";
import { setSensorResultSchema } from "./sensorToolOutputSchemas";
import { runSessionSensorMutation, type SessionSensorHost } from "./sessionSensor";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { EMULATOR_SENSOR_NAMES } from "../features/utility/EmulatorSensors";
import {
  defaultEmulatorSensorConsoleFactory,
  defaultEmulatorSensorRestoreRegistry,
  type EmulatorSensorConsoleFactory,
  type EmulatorSensorRestoreRegistry,
} from "../features/utility/EmulatorSensorRestore";
import { setEmulatorSensor } from "../features/utility/SetSensor";

const setSensorInput = z.object({
  sensor: z
    .enum(EMULATOR_SENSOR_NAMES)
    .describe(
      "Emulator sensor. Three values (x:y:z): acceleration m/s² ±1000, gyroscope rad/s ±100, " +
        "magnetic-field µT ±2000; orientation azimuth 0..360, pitch -180..180, roll -90..90 degrees. " +
        "One value: temperature °C -273.15..1000, proximity cm 0..100, light lux 0..200000, " +
        "pressure hPa 0..2000, humidity % 0..100.",
    ),
  value: z
    .array(z.number().finite())
    .min(1)
    .max(3)
    .optional()
    .describe("Value(s) to set, in the sensor's arity and range; rounded to 6 decimals."),
  reset: z
    .boolean()
    .optional()
    .describe(
      "true restores the value read before the first setSensor change; use instead of value.",
    ),
});

export interface SetSensorToolDependencies {
  sessionManager?: () => SessionSensorHost | undefined;
  consoleFor?: EmulatorSensorConsoleFactory;
  registry?: EmulatorSensorRestoreRegistry;
}

export const createSetSensorHandler =
  (deps: SetSensorToolDependencies = {}): DeviceToolHandler<typeof setSensorInput> =>
  async (device, args, _progress, signal) => {
    const sessionManager = args.sessionUuid
      ? (deps.sessionManager ?? (() => defaultDaemonContext.sessionManager()))()
      : undefined;
    const consoleFor = deps.consoleFor ?? defaultEmulatorSensorConsoleFactory;
    const result = await runSessionSensorMutation(
      sessionManager,
      args.sessionUuid,
      device.deviceId,
      (owner) =>
        setEmulatorSensor(
          device,
          { sensor: args.sensor, value: args.value, reset: args.reset },
          {
            console: consoleFor(device),
            registry: deps.registry ?? defaultEmulatorSensorRestoreRegistry,
            owner,
            signal,
          },
        ),
    );
    return createStructuredToolResponse({ success: true, ...result });
  };

const setSensorTool = defineDeviceTool({
  name: "setSensor",
  description:
    "Set or reset one Android emulator virtual sensor (acceleration, gyroscope, magnetic-field, orientation, " +
    "temperature, proximity, light, pressure, humidity) through the emulator console. Pass exactly one of value " +
    "or reset: true. The result reports applied and previous values plus a restore receipt. The value read " +
    "before the first change is kept; in a daemon session, release or rebind restores every sensor the session " +
    "changed. Sessionless changes persist until reset. Physical devices and iOS are refused. Read current " +
    'values with getDeviceState include: ["sensors"].',
  input: setSensorInput,
  options: { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: setSensorResultSchema },
});

export const setSensorSchema = setSensorTool.schema;

export function registerSensorTools(deps: SetSensorToolDependencies = {}): void {
  setSensorTool.register(undefined, createSetSensorHandler(deps));
}
