import { PerformanceTracker } from "../../../utils/PerformanceTracker";

import { DeviceServiceClient } from "../DeviceServiceClient";

import { CtrlProxyHierarchy as CtrlProxyHierarchyDelegate } from "./CtrlProxyHierarchy";

import type { CtrlProxySyncedHierarchy } from "./types";

/** Connection-only diagnostic reads; the concrete client owns probe construction. */
export abstract class IosCtrlProxyDiagnosticsFacade extends DeviceServiceClient {
  protected abstract readonly transientObserver: boolean;
  protected abstract get hierarchy(): CtrlProxyHierarchyDelegate;
  protected abstract createDiagnosticsProbe(): IosCtrlProxyDiagnosticsFacade;
  abstract connectWithoutSetup(signal?: AbortSignal): Promise<boolean>;
  abstract getCachedSupportedFeatures(): string[] | null;

  public connectForObservationRead(): Promise<boolean> {
    return super.ensureConnected();
  }

  /**
   * An open resident socket can serve a read. Otherwise only a transient observer
   * dials: its promises, timers, budgets and handshake cache belong to the probe.
   * Never close, reconnect, or update any state on the resident client.
   */
  protected async readForDiagnostics<T>(
    read: (client: IosCtrlProxyDiagnosticsFacade) => Promise<T>,
    unavailable: T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.isConnected()) {
      return read(this);
    }
    if (this.transientObserver) {
      return (await this.connectWithoutSetup(signal)) ? read(this) : unavailable;
    }
    const probe = this.createDiagnosticsProbe();
    try {
      return (await probe.connectWithoutSetup(signal)) ? await read(probe) : unavailable;
    } finally {
      await probe.close();
    }
  }

  /** Read both identity fields from one handshake on one connection. */
  public async getRunnerIdentityForDiagnostics(
    signal?: AbortSignal,
  ): Promise<{ commands: string[] | null; features: string[] | null } | null> {
    return this.readForDiagnostics(
      async (client) => {
        await client.waitForHandshake(undefined, signal);
        signal?.throwIfAborted();
        const commands = client.getCachedSupportedCommands();
        return commands === null
          ? null
          : { commands, features: client.getCachedSupportedFeatures() };
      },
      null,
      signal,
    );
  }

  /** Cached handshake or connection-only read; never sets up a runner. */
  public async getSupportedCommandsForDiagnostics(signal?: AbortSignal): Promise<string[] | null> {
    return this.readForDiagnostics(
      async (client) => {
        await client.waitForHandshake(undefined, signal);
        signal?.throwIfAborted();
        return client.getCachedSupportedCommands();
      },
      null,
      signal,
    );
  }

  public async getSupportedFeaturesForDiagnostics(signal?: AbortSignal): Promise<string[] | null> {
    return this.readForDiagnostics(
      async (client) => {
        await client.waitForHandshake(undefined, signal);
        signal?.throwIfAborted();
        return client.getCachedSupportedFeatures();
      },
      null,
      signal,
    );
  }

  /** Hierarchy read on a connection-only transport, with no reconnect fallback. */
  public async requestHierarchySyncForDiagnostics(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs: number = 5000,
  ): Promise<CtrlProxySyncedHierarchy | null> {
    const deadline = this.timer.now() + Math.max(0, timeoutMs);
    return this.readForDiagnostics(
      (client) =>
        client.hierarchy.requestHierarchySync(
          perf,
          disableAllFiltering,
          signal,
          Math.max(0, deadline - this.timer.now()),
          true,
          { observerMode: true },
        ),
      null,
      signal,
    );
  }
}
