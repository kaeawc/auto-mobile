/**
 * Opt-in gate for provisioning (creating) simulators/emulators.
 *
 * Auto-creating devices is deliberately NOT default product behaviour — spawning
 * a simulator on a developer's machine is a side effect they did not ask for.
 * The capability is therefore expressed two equivalent ways so both MCP/CLI and
 * containerised CI can turn it on:
 *
 *   1. `--create-if-missing` on the device-start path (surfaces as the
 *      `createIfMissing` startDevice parameter).
 *   2. `AUTOMOBILE_ALLOW_DEVICE_CREATE=1` (or `true`) for environments that
 *      cannot easily thread flags.
 *
 * Precedence: an explicit flag — either value — wins over the env var. Default
 * is off on both platforms.
 *
 * The gate is an injectable seam so call sites never read `process.env`
 * directly and unit tests never have to mutate the real environment.
 */

/** Env var that enables device creation when no explicit flag is supplied. */
export const DEVICE_CREATE_ENV_VAR = "AUTOMOBILE_ALLOW_DEVICE_CREATE";

/** Values accepted as "on" for {@link DEVICE_CREATE_ENV_VAR}. */
const TRUTHY_ENV_VALUES = new Set(["1", "true"]);

/** Prefix applied to every device AutoMobile creates, so they are identifiable/cleanable. */
export const CREATED_DEVICE_NAME_PREFIX = "AutoMobile";

/** Narrow read-only view of the environment, so tests never touch `process.env`. */
export interface EnvironmentReader {
  get(name: string): string | undefined;
}

export class ProcessEnvironmentReader implements EnvironmentReader {
  get(name: string): string | undefined {
    return process.env[name];
  }
}

export interface DeviceCreationGate {
  /**
   * @param explicitFlag - the value of `--create-if-missing` / `createIfMissing`
   *                       when the caller supplied it, otherwise `undefined`.
   * @returns whether the caller is allowed to create a device.
   */
  isCreationAllowed(explicitFlag?: boolean): boolean;

  /** Human-readable reason for the current decision, for logging. */
  describeSource(explicitFlag?: boolean): string;
}

export class EnvDeviceCreationGate implements DeviceCreationGate {
  constructor(private readonly environment: EnvironmentReader = new ProcessEnvironmentReader()) {}

  isCreationAllowed(explicitFlag?: boolean): boolean {
    if (typeof explicitFlag === "boolean") {
      return explicitFlag;
    }
    return isTruthyCreationEnvValue(this.environment.get(DEVICE_CREATE_ENV_VAR));
  }

  describeSource(explicitFlag?: boolean): string {
    if (typeof explicitFlag === "boolean") {
      return `--create-if-missing=${explicitFlag}`;
    }
    const raw = this.environment.get(DEVICE_CREATE_ENV_VAR);
    if (raw === undefined) {
      return "default (off)";
    }
    return `${DEVICE_CREATE_ENV_VAR}=${raw}`;
  }
}

/** `1` and `true` (case-insensitive, whitespace-tolerant) mean on; everything else is off. */
export function isTruthyCreationEnvValue(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  return TRUTHY_ENV_VALUES.has(raw.trim().toLowerCase());
}

let moduleGate: DeviceCreationGate | null = null;

export function getDeviceCreationGate(): DeviceCreationGate {
  if (!moduleGate) {
    moduleGate = new EnvDeviceCreationGate();
  }
  return moduleGate;
}

export function setDeviceCreationGate(gate: DeviceCreationGate): void {
  moduleGate = gate;
}

export function resetDeviceCreationGate(): void {
  moduleGate = null;
}
