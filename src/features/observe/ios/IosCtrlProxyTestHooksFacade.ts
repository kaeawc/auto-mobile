import type WebSocket from "ws";
import { CtrlProxyBuildContext } from "./CtrlProxyBuildContext";
import { CtrlProxyInboundMessages } from "./CtrlProxyInboundMessages";
import type {
  CtrlProxyObservationStream,
  ScreenshotObservationStreamOptions,
} from "./CtrlProxyObservationStream";
import { CtrlProxyRunnerRecovery } from "./CtrlProxyRunnerRecovery";
import { CtrlProxySdkCapabilities } from "./CtrlProxySdkCapabilities";
import { CtrlProxySdkEvents } from "./CtrlProxySdkEvents";
import { CtrlProxySdkScreenIdentity } from "./CtrlProxySdkScreenIdentity";
import { IosCtrlProxyDelegatingFacade } from "./IosCtrlProxyDelegatingFacade";
import type { IosHierarchyMessageEffects } from "./IosHierarchyMessageEffects";
import type { WebSocketMessage } from "./types";

/**
 * The typed test seams of the iOS client, kept out of {@link IOSCtrlProxyClient} so the client
 * file stays under its size cap. It reaches the client's collaborators through the abstract
 * members below, which the client implements; production code never reads these hooks.
 */
export abstract class IosCtrlProxyTestHooksFacade extends IosCtrlProxyDelegatingFacade {
  protected abstract readonly messageEffects: IosHierarchyMessageEffects;
  protected abstract readonly observationStream: CtrlProxyObservationStream;
  protected abstract readonly runnerRecovery: CtrlProxyRunnerRecovery;
  protected abstract readonly sdkScreenIdentity: CtrlProxySdkScreenIdentity;
  protected abstract readonly sdkEvents: CtrlProxySdkEvents;
  protected abstract readonly buildContext: CtrlProxyBuildContext;
  protected abstract readonly inbound: CtrlProxyInboundMessages;
  protected abstract updatePort(port: number): void;
  protected abstract processMessage(message: WebSocketMessage): void;
  protected abstract pushHierarchyToObservationStream(
    ...args: Parameters<CtrlProxyObservationStream["pushHierarchyToObservationStream"]>
  ): void;
  protected abstract pushScreenshotToObservationStream(
    options: ScreenshotObservationStreamOptions,
  ): void;
  protected abstract handleMessage(data: WebSocket.Data): void;

  /** Typed access to lifecycle and observation state for deterministic tests. */
  get testHooks() {
    const client = this;
    return {
      getWebSocketUrl: () => this.getWebSocketUrl(),
      updatePort: (port: number) => this.updatePort(port),
      connectWebSocket: () => this.connectWebSocket(),
      onConnectAttemptFailed: () => this.onConnectAttemptFailed(),
      scheduleReconnect: () => this.scheduleReconnect(),
      onConnectionClosed: () => this.onConnectionClosed(),
      processMessage: (message: WebSocketMessage) => this.processMessage(message),
      createDelegateContext: () => this.createDelegateContext(),
      createHierarchyDelegateContext: () => this.createHierarchyDelegateContext(),
      hierarchy: () => this.hierarchy,
      readForDiagnostics: this.readForDiagnostics.bind(this),
      messageEffects: this.messageEffects,
      requestManager: this.requestManager,
      screenGeometry: this.screenGeometry,
      pushHierarchyToObservationStream: (
        ...args: Parameters<CtrlProxyObservationStream["pushHierarchyToObservationStream"]>
      ) => this.pushHierarchyToObservationStream(...args),
      pushScreenshotToObservationStream: (options: ScreenshotObservationStreamOptions) =>
        this.pushScreenshotToObservationStream(options),
      retainScaleMetadataFrom: (
        hierarchy: { nativeScale?: number; pixelWidth?: number; pixelHeight?: number } | null,
      ) => this.retainScaleMetadataFrom(hierarchy),
      get cachedHierarchy() {
        return client.cachedHierarchy;
      },
      set cachedHierarchy(value: typeof client.cachedHierarchy) {
        client.cachedHierarchy = value;
      },
      get pendingConnectSocket() {
        return client.pendingConnectAbort?.socket ?? null;
      },
      get recoveryPromise() {
        return client.recoveryPromise;
      },
    };
  }

  public getObservationStreamTestHooks(): Pick<
    CtrlProxyObservationStream,
    "suppressedRequestIds" | "suppressHierarchyObservationStreamPush"
  > {
    return this.observationStream;
  }

  public getRunnerRecoveryTestHooks(): Pick<
    CtrlProxyRunnerRecovery,
    "failPendingRestart" | "restartServiceIfBooted" | "diagnostics" | "resetInFlightForTesting"
  > {
    return this.runnerRecovery;
  }

  public getInboundMessageTestHooks(): Pick<CtrlProxyInboundMessages, "processMessage"> {
    return this.inbound;
  }

  public getSdkCapabilityTestHooks(): Pick<
    CtrlProxySdkCapabilities,
    "ensureSdkCapability" | "sdkCapabilityGate" | "requestSdkCapabilities" | "seedForTesting"
  > {
    return this.sdkCapability;
  }

  public getSdkScreenIdentityTestHooks(): Pick<
    CtrlProxySdkScreenIdentity,
    "activateSdkScreenIdentitySession"
  > {
    return this.sdkScreenIdentity;
  }

  public getSdkEventPollingTestHooks(): {
    polling: Pick<
      CtrlProxySdkEvents,
      | "startSdkEventPolling"
      | "runSdkEventPollCycle"
      | "currentSdkEventPollIntervalMs"
      | "stopSdkEventPolling"
      | "decodeSdkEventBatches"
      | "diagnostics"
    >;
    receiveMessage: (data: WebSocket.Data) => void;
  } {
    return { polling: this.sdkEvents, receiveMessage: (data) => this.handleMessage(data) };
  }

  public getBuildContextDiagnosticsForTesting() {
    return this.buildContext.diagnostics();
  }
}
