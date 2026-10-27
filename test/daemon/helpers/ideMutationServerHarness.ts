import type { Socket } from "node:net";
import { spyOn } from "bun:test";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import type { DaemonStateAccess } from "../../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceManager } from "../../fakes/FakeDeviceManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { fakeBindLock, unreachableMcpDispatcher } from "../../helpers/createTestUnixSocketServer";
import { createFakeDaemonState } from "./inputSocketHarness";

/**
 * A `UnixSocketServer` that accepts connections without `start()` and exposes its in-flight
 * request handlers through two named seams over protected members, so suites drive a connection
 * without casting the server to a private-member shape.
 */
export class ConnectableServerHarness extends UnixSocketServer {
  /** Behave as a started server and adopt one connection. */
  connect(socket: Socket): void {
    this.acceptingRequests = true;
    this.handleConnection(socket);
  }

  /** Resolves once every request handler the connection started has finished. */
  async settleActiveHandlers(): Promise<void> {
    await Promise.all([...this.activeRequestHandlers]);
  }
}

/** The state seam these suites share: the shared fake pool plus the suite's real session manager. */
function ideMutationState(sessionManager: SessionManager): DaemonStateAccess {
  return {
    ...createFakeDaemonState(),
    getSessionManager: () => sessionManager,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
}

/** A daemon state that reports itself uninitialised, for servers that never reach a session. */
export function uninitializedDaemonState(): DaemonStateAccess {
  const timer = new FakeTimer();
  return {
    ...ideMutationState(new SessionManager(timer, new FakeDeviceSessionPersistence())),
    isInitialized: () => false,
  };
}

/** Same defaults as `createTestUnixSocketServer`, returning the connectable harness. */
export function createConnectableServer(
  ...args: ConstructorParameters<typeof UnixSocketServer>
): ConnectableServerHarness {
  return new ConnectableServerHarness(
    args[0],
    args[1],
    args[2],
    args[3],
    { mcpDispatcher: unreachableMcpDispatcher, ...args[4] },
    args[5],
    { bindLock: fakeBindLock, ...(args[6] ?? {}) },
    args[7],
  );
}

/** A connectable server over the shared fake pool with the storage tools enabled. */
export function createIdeMutationServer(sessionManager: SessionManager): ConnectableServerHarness {
  return createConnectableServer(
    "unused",
    ideMutationState(sessionManager),
    new FakeTimer(),
    null,
    { sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} } },
  );
}

/** Make discovery report exactly this Android device on every platform. */
export function useBootedAndroidDevice(device: BootedDevice): void {
  const deviceManager = new FakeDeviceManager();
  deviceManager.bootedDevices = [device];
  PlatformDeviceManagerFactory.setInstance(deviceManager);
}

/**
 * Route `AndroidCtrlProxyManager.getInstance` to one real manager (over a fake adb factory) whose
 * version check is `ensureCompatibleVersion`. The returned function restores both.
 */
export function stubAndroidCtrlProxyManager(
  device: BootedDevice,
  ensureCompatibleVersion: () => Promise<unknown>,
): () => void {
  const manager = AndroidCtrlProxyManager.getInstanceForTesting(device, new FakeAdbClientFactory());
  const ensure = spyOn(manager, "ensureCompatibleVersion").mockImplementation(async () => {
    await ensureCompatibleVersion();
    return { status: "compatible" };
  });
  const getInstance = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue(manager);
  return () => {
    getInstance.mockRestore();
    ensure.mockRestore();
    AndroidCtrlProxyManager.evictInstance(manager);
  };
}
