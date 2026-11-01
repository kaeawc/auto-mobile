import type { Kysely } from "kysely";
import type { Database } from "./types";
import { ProvisionedDeviceTransportTombstoneRepository } from "./provisionedDeviceTransportTombstoneRepository";
import {
  DurableProvisionedDeviceTransportFence,
  InMemoryProvisionedDeviceTransportFence,
  initializeProvisionedDeviceTransportFence,
  type ProvisionedDeviceTransportFence,
} from "../utils/provisionedDeviceTransportFence";
import type { Timer } from "../utils/SystemTimer";
import { AMBIENT_ENV, readEnvRaw } from "../config/env";

interface DefaultFenceOptions {
  isTest?: boolean;
  database?: Kysely<Database>;
  timer?: Pick<Timer, "now">;
}

export function createDefaultProvisionedDeviceTransportFence(
  options: DefaultFenceOptions = {},
): ProvisionedDeviceTransportFence {
  if (options.isTest ?? readEnvRaw(AMBIENT_ENV.NODE_ENV) === "test") {
    return new InMemoryProvisionedDeviceTransportFence();
  }
  return new DurableProvisionedDeviceTransportFence({
    store: new ProvisionedDeviceTransportTombstoneRepository({ db: options.database }),
    timer: options.timer,
  });
}

/** Repository construction is lazy about DB access, preserving startup ownership/migration guards. */
export function installDefaultProvisionedDeviceTransportFence(
  options: DefaultFenceOptions = {},
): ProvisionedDeviceTransportFence {
  return initializeProvisionedDeviceTransportFence(() =>
    createDefaultProvisionedDeviceTransportFence(options),
  );
}
