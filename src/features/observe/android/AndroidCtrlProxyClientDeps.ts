import { InstalledAppsStore } from "../../../db/installedAppsRepository";
import { type IdGenerator } from "../../../utils/IdGenerator";
import { Timer } from "../../../utils/SystemTimer";
import type { CrashEventSink } from "../../../utils/interfaces/CrashMonitor";
import { type Logger } from "../../../utils/logger";
import { RetryExecutor } from "../../../utils/retry/RetryExecutor";
import { type DeviceConnectionLostNotifier } from "../DeviceConnectionLostNotifier";
import { WebSocketFactory } from "../DeviceServiceClient";
import { AndroidSdkEventIngestor } from "./AndroidSdkEventIngestor";
import { type AndroidServiceManagerFactory } from "./AndroidServiceRecovery";
import { type CertificateFileSystem } from "./CtrlProxyCertificates";
import { type CtrlProxyForwardLease } from "./CtrlProxyForwardLease";

export interface AndroidCtrlProxyClientDeps {
  /** Creates the client's WebSocket transport. */
  webSocketFactory?: WebSocketFactory;
  /** Schedules connection and request deadlines. */
  timer?: Timer;
  /** Stores installed-app metadata. */
  installedAppsRepository?: InstalledAppsStore;
  /** Executes retryable operations. */
  retryExecutor?: RetryExecutor;
  /** Records app crash events. */
  crashEventSink?: CrashEventSink;
  /** Reports lost device connections. */
  deviceConnectionLostNotifier?: DeviceConnectionLostNotifier;
  /** Ingests SDK telemetry, crash, and ANR events. */
  sdkEventIngestor?: AndroidSdkEventIngestor;
  /** Logs client lifecycle and cleanup events. */
  logger?: Logger;
  /** Provides certificate file operations. */
  certificateFileSystem?: CertificateFileSystem;
  /** Coordinates ownership of the device's CtrlProxy forward. */
  ctrlProxyForwardLease?: CtrlProxyForwardLease;
  /** Creates the accessibility-service recovery manager. */
  serviceManagerFactory?: AndroidServiceManagerFactory;
  /** Generates client and request identifiers. */
  idGenerator?: IdGenerator;
  /** Creates a detached observer without service recovery or auto-reconnect. */
  transientObserver?: boolean;
}
