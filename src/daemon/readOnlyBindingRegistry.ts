import { existsSync } from "node:fs";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { DeviceClaims } from "./deviceClaims";
import type { BindingRegistry } from "./sessionBroker/registry/bindingRegistry";
import {
  defaultBindingRegistryPath,
  openSqliteBindingRegistry,
} from "./sessionBroker/registry/sqliteBindingRegistry";

/** What the doctor needs from the registry: one read, on a handle it also closes. */
type OpenedRegistry = Pick<BindingRegistry, "findDeviceHolder"> & {
  close(): Promise<void>;
  deviceClaims?(): Pick<DeviceClaims, "get" | "list">;
};

export interface ReadOnlyBindingRegistryDependencies {
  registryPath?: () => string;
  exists?: (path: string) => boolean;
  open?: (dbPath: string) => Promise<OpenedRegistry>;
}

/**
 * A read-only view of the persisted binding registry for `doctor` (#13279). It never starts a
 * daemon, never creates the registry file or its directory, and never migrates: a missing file,
 * a registry awaiting its daemon's upgrade or an unreadable one all read as "no exec owners"
 * (logged), because the doctor must not touch the resident daemon's state. Each lookup opens and
 * closes its own short-lived connection.
 */
export function createReadOnlyBindingRegistry(
  dependencies: ReadOnlyBindingRegistryDependencies = {},
): Pick<BindingRegistry, "findDeviceHolder"> {
  const registryPath = dependencies.registryPath ?? (() => defaultBindingRegistryPath());
  const exists = dependencies.exists ?? existsSync;
  const open =
    dependencies.open ?? ((dbPath) => openSqliteBindingRegistry({ dbPath, migrate: false }));
  return {
    async findDeviceHolder(platform, stableDeviceId) {
      const dbPath = registryPath();
      if (!exists(dbPath)) {
        return null;
      }
      let registry: OpenedRegistry;
      try {
        registry = await open(dbPath);
      } catch (error) {
        // Not-yet-migrated or busy registries cannot be read without writing; exec owners are
        // then unknown, which the doctor reports as no record rather than failing the check.
        logger.warn(`doctor: binding registry not readable: ${errorMessage(error)}`, error);
        return null;
      }
      try {
        return await registry.findDeviceHolder(platform, stableDeviceId);
      } finally {
        await registry.close();
      }
    },
  };
}

/**
 * The same read-only view of the host-wide `device_claims` table (#11811): no registry file, a
 * registry awaiting its daemon's upgrade or an unreadable one all read as "no claims" (logged).
 */
export function createReadOnlyDeviceClaims(
  dependencies: ReadOnlyBindingRegistryDependencies = {},
): Pick<DeviceClaims, "get" | "list"> {
  const registryPath = dependencies.registryPath ?? (() => defaultBindingRegistryPath());
  const exists = dependencies.exists ?? existsSync;
  const open =
    dependencies.open ?? ((dbPath) => openSqliteBindingRegistry({ dbPath, migrate: false }));
  async function withClaims<T>(
    empty: T,
    read: (claims: Pick<DeviceClaims, "get" | "list">) => Promise<T>,
  ): Promise<T> {
    const dbPath = registryPath();
    if (!exists(dbPath)) {
      return empty;
    }
    let registry: OpenedRegistry;
    try {
      registry = await open(dbPath);
    } catch (error) {
      logger.warn(`doctor: device claims not readable: ${errorMessage(error)}`, error);
      return empty;
    }
    try {
      const claims = registry.deviceClaims?.();
      return claims ? await read(claims) : empty;
    } finally {
      await registry.close();
    }
  }
  return {
    get: (platform, deviceId) => withClaims(undefined, (claims) => claims.get(platform, deviceId)),
    list: () => withClaims([], (claims) => claims.list()),
  };
}
