import type { McpServer } from "@modelcontextprotocol/server";
import type { IosDoctorDependencies } from "../doctor/checks/ios";
import { ActionableError } from "../models/ActionableError";
import type { TaskLeaseKeepalive } from "./tasks/taskLeaseKeepalive";

/** The keyed binding operations consumed by a request server, independent of its storage class. */
export interface McpSessionToolBindingStore {
  attach(binding: { releaseLocalSession(sessionUuid: string): boolean }): () => void;
  dispose(): void;
  boundSessionUuid(key: string): string | undefined;
  releasedSessionUuid(key: string): string | undefined;
  acquiredSessionUuids(key: string): ReadonlySet<string>;
  toolSelectionProfileUuid(key: string): string | undefined;
  bind(key: string, sessionUuid: string): boolean;
  bindToolSelectionProfile(key: string, profileUuid: string): boolean;
  releaseSession(sessionUuid: string): boolean;
}

/** Construction contract shared by daemon ingress and the server implementation. */
export interface McpServerFactoryOptions {
  iosDependencies?: IosDoctorDependencies;
  debug?: boolean;
  sessionContext?: {
    sessionId?: string;
    initialSessionToolBinding?: string;
    initialReleasedSession?: string;
    initialToolSelectionProfile?: string;
  };
  daemonMode?: boolean;
  /** Request header session key; survives across per-request servers (#4678). */
  requestMcpSessionId?: string;
  /** Only trusted daemon forwards may prefer the in-band session id (#13315). */
  trustForwardedMcpSessionId?: boolean;
  /** Single-request servers use daemon-scoped keyed bindings and are never notified. */
  stateless?: boolean;
  /** Overrides where keyed bindings live; tests share one store across servers. */
  sessionToolBindingStore?: McpSessionToolBindingStore;
  /** Startup-captured capability, never a client tool argument. */
  acceptanceDiscoveryCapability?: string;
  /** Proxy identity lets tasks survive control-socket reconnects (#4668). */
  taskOwnerKey?: string;
  taskLeaseKeepalive?: TaskLeaseKeepalive;
}

export interface McpServerFactory {
  createMcpServer(options: McpServerFactoryOptions): McpServer;
  refreshMcpResourceList(): Promise<void>;
}

const unregisteredFactory: McpServerFactory = {
  createMcpServer: () => {
    throw new ActionableError(
      "The MCP server factory is not registered. Load src/server before serving daemon MCP requests.",
    );
  },
  // Daemon discovery may run without a server or resource registry.
  refreshMcpResourceList: async () => {},
};

let factory: McpServerFactory = unregisteredFactory;

/** Puts the unregistered default back for one test; the returned function restores the prior port. */
export function isolateMcpServerFactoryForTesting(): () => void {
  return registerMcpServerFactory(unregisteredFactory);
}

/** Installed by src/server at module load; tests can replace and restore the whole port. */
export function registerMcpServerFactory(next: McpServerFactory): () => void {
  const previous = factory;
  factory = next;
  return () => {
    factory = previous;
  };
}

/** Resolve at call time so daemon services constructed before registration stay live. */
export function createMcpServer(options: McpServerFactoryOptions): McpServer {
  return factory.createMcpServer(options);
}

export function refreshMcpResourceList(): Promise<void> {
  return factory.refreshMcpResourceList();
}
