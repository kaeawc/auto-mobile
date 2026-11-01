import { ActionableError } from "../../models/ActionableError";
import { tryAcquireExclusiveLock, releaseExclusiveLock } from "../../utils/fileLock";
import { defaultLockOwnerGenerationProbe } from "../lockOwnerGeneration";
import { defaultBindingRegistryPath } from "./registry/sqliteBindingRegistry";
import type { BindingProcessIdentity } from "./registry/bindingRegistry";

export interface SessionBrokerHostLock {
  acquire(): void;
  release(): void;
}

/** Existing PID/generation lock primitive, held for the lifetime of the broker service. */
export function sessionBrokerHostLock(
  owner: BindingProcessIdentity,
  path = `${defaultBindingRegistryPath()}.session-broker.lock`,
): SessionBrokerHostLock {
  return {
    acquire: () => {
      if (
        !tryAcquireExclusiveLock(path, {
          pid: owner.pid,
          ownerToken: owner.daemonId,
          ownerGeneration: defaultLockOwnerGenerationProbe,
        })
      ) {
        throw new ActionableError(
          "Another provider owns session-broker execution on this host; stop it before starting a replacement",
        );
      }
    },
    release: () => releaseExclusiveLock(path, owner.pid, owner.daemonId),
  };
}
