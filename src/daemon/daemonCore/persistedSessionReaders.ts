import type { DaemonDeviceSessionStore } from "../daemonDependencies";

export function persistedSessionReaders(repository: () => DaemonDeviceSessionStore) {
  return {
    getSession: (uuid: string) => repository().getSession(uuid),
    getPersistedSession: (uuid: string) => repository().getSession(uuid),
  };
}
