import { AndroidCtrlProxyObservationClient } from "./AndroidCtrlProxyObservationClient";
import type WebSocket from "ws";
import type { AndroidCtrlProxyClientTestHooks } from "./AndroidCtrlProxyClientTestHooks";

/**
 * The typed test seam of the Android client, kept out of {@link AndroidCtrlProxyClient} so the
 * client file stays under its size cap. It reaches the client's collaborators through the
 * abstract members below, which the client implements; production code never reads it.
 */
export abstract class AndroidCtrlProxyTestHooksFacade extends AndroidCtrlProxyObservationClient {
  protected abstract handleMessage(data: WebSocket.Data): Promise<void>;

  /** @internal Typed view of internals for unit tests; production code must not use it. */
  get testHooks(): AndroidCtrlProxyClientTestHooks {
    const client = this;
    return {
      requestManager: client.requestManager,
      forcedRestartBudget: client.forcedRestartBudget,
      text: () => client.text,
      gestures: () => client.gestures,
      storage: () => client.storage,
      certificates: () => client.certificates,
      focus: () => client.focus,
      packages: () => client.packages,
      prototypes: () => client.prototypes,
      highlights: () => client.highlights,
      webSocketMessageHandlers: () => client.webSocketMessageHandlers,
      createDelegateContext: () => client.createDelegateContext(),
      createHierarchyDelegateContext: () => client.createHierarchyDelegateContext(),
      hierarchy: () => client.hierarchy,
      isCommandSupported: (messageType) => client.isCommandSupported(messageType),
      rejectedCommands: client.rejectedCommands,
      screenshotObservationStreamSuppressions: client.screenshotObservationStreamSuppressions,
      get workProfileMonitor() {
        return client.workProfileMonitor;
      },
      set workProfileMonitor(value) {
        client.workProfileMonitor = value;
      },
      createCertificatesDelegateContext: () => client.createCertificatesDelegateContext(),
      getScreenshotRequester: () => client.getScreenshotRequester(),
      finishEstablishedConnection: (socket) => client.finishEstablishedConnection(socket),
      handleMessage: (data) => client.handleMessage(data),
      onConnectionEstablished: () => client.onConnectionEstablished(),
      setCachedHierarchy: (value) => {
        client.cachedHierarchy = value;
      },
      overrideCancelScreenshotBackoff: (cancel) => {
        client.cancelScreenshotBackoff = cancel;
      },
      overrideConnectWebSocket: (connect) => {
        client.connectWebSocket = connect;
      },
      extendDelegateContextFields: (extra) => {
        const base = client.extraDelegateContextFields.bind(client);
        client.extraDelegateContextFields = () => ({ ...base(), ...extra() });
      },
      get installedGestures() {
        return client._gestures;
      },
      set installedGestures(value) {
        client._gestures = value;
      },
      injected: () => ({
        ctrlProxyForwardLease: client.ctrlProxyForwardLease,
        forwardClientProbe: client.forwardClientProbe,
        loggerInstance: client.loggerInstance,
        transientObserver: client.transientObserver,
        timer: client.timer,
        device: client.device,
        adb: client.adb,
        webSocketFactory: client.webSocketFactory,
        certificateFileSystem: client.certificateFileSystem,
        serviceManagerFactory: client.serviceManagerFactory,
        idGenerator: client.idGenerator,
        screenshotBackoffScheduler: client.screenshotBackoffScheduler,
        portAllocationId: client.portAllocationId,
      }),
      cachedHierarchy: () => client.cachedHierarchy,
      handleWebSocketMessage: (data) => client.handleWebSocketMessage(data),
      getWebSocketUrl: () => client.getWebSocketUrl(),
      removeCtrlProxyPortForward: (port) => client.removeCtrlProxyPortForward(port),
      get recoveryPromise() {
        return client.recoveryPromise;
      },
      set recoveryPromise(value) {
        client.recoveryPromise = value;
      },
      get isRecoveringService() {
        return client.isRecoveringService;
      },
      set isRecoveringService(value) {
        client.isRecoveringService = value;
      },
      get connectionAttempts() {
        return client.connectionAttempts;
      },
      set connectionAttempts(value) {
        client.connectionAttempts = value;
      },
      get lastConnectionAttempt() {
        return client.lastConnectionAttempt;
      },
      set lastConnectionAttempt(value) {
        client.lastConnectionAttempt = value;
      },
      get connectionResetMs() {
        return client.config.connectionResetMs;
      },
      set connectionResetMs(value) {
        client.config.connectionResetMs = value;
      },
      get portForwardingSetup() {
        return client.portForwardingSetup;
      },
      set portForwardingSetup(value) {
        client.portForwardingSetup = value;
      },
      get localPort() {
        return client.localPort;
      },
      set localPort(value) {
        client.localPort = value;
      },
    };
  }
}
