import type { z } from "zod/v4";
import type { ProtoViewerDevice } from "../../features/prototype/protoViewer/protoViewerDevice";
import type { DeviceWindowCacheInvalidator } from "../../features/observe/DeviceWindowCacheInvalidator";
import type { HierarchyCapture } from "../../features/observe/HierarchyCapture";
import type { PrototypeResult } from "../../features/observe/android/ctrlProxyProtocol";
import type { PrototypeAdbReverseManager } from "../../features/prototype/PrototypeAdbReverseManager";
import type { PrototypeCommitGenerations } from "../../features/prototype/PrototypeCommitGenerations";
import type { PrototypeEventCoordinator } from "../../features/prototype/PrototypeEventCoordinator";
import type { PrototypeStatusStore } from "../../features/prototype/PrototypeStatusStore";
import type { PrototypeTransport } from "../../features/prototype/PrototypeTransport";
import type {
  AndroidPrototypeTransport,
  AndroidPrototypeClient,
} from "../../features/prototype/androidPrototypeTransport";
import type {
  IosPrototypeTransport,
  PrototypeAgentConnections,
} from "../../features/prototype/ios/iosPrototypeTransport";
import type { ResolvedPrototypeAnchor } from "../../features/prototype/prototypeAnchors";
import type {
  PrototypeAssetFileReader,
  PrototypeObservationScreenshotReader,
  UploadedPrototypeAsset,
} from "../../features/prototype/prototypeAssetUploader";
import type { PrototypeAssetUpload } from "../../features/prototype/prototypeAssets";
import type { PrototypeDisplayDependencies } from "../../features/prototype/prototypeDisplay";
import type { PrototypeSpec } from "../../features/prototype/prototypeSpec";
import type { PrototypeWindowChrome } from "../../features/prototype/prototypeWindowChrome";
import type { BootedDevice } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { PrototypeEventLifecycle } from "../prototypeLifecycle";
import type { IosSavedPrototypeInstaller } from "../prototypeSavedActions";
import type { prototypeOutputSchema } from "./schemas";

export type PrototypeClient = AndroidPrototypeClient;
/**
 * The transport for one call; `android` carries the CtrlProxy-only display gate and inspect, `ios`
 * the injected agent's advertised capabilities.
 */
export interface PrototypeTarget {
  transport: PrototypeTransport;
  android?: AndroidPrototypeTransport;
  ios?: Pick<
    IosPrototypeTransport,
    "supportsCapability" | "status" | "clearStorage" | "advanceClock"
  >;
}
export interface PrototypeToolDependencies {
  /** Host feature gates; tests supply an isolated environment. */
  env?: NodeJS.ProcessEnv;
  shaderAssetCache?: Pick<
    import("../../features/prototype/prototypeAssetCache").PrototypeAssetCache,
    "get"
  >;
  /** Saved iOS actions use the host installer without an agent connection; created lazily by default. */
  iosSavedPrototypeInstaller?: IosSavedPrototypeInstaller;
  /** ProtoViewer on Android or an iOS simulator for saved `save`/`open` (#13621). */
  protoViewerFactory?: (device: BootedDevice) => ProtoViewerDevice;
  /** Reads local files named by `assets`; tests inject an in-memory reader. */
  assetFileReader?: PrototypeAssetFileReader;
  /** Resolves `assets[].observation` URIs; defaults to the observation screenshot resource. */
  observationScreenshotReader?: PrototypeObservationScreenshotReader;
  clientFactory?: (device: BootedDevice) => PrototypeClient;
  /** Injected iOS simulator agent connections, recorded by `launchApp {prototype: true}` (#10567). */
  agentConnections?: PrototypeAgentConnections;
  adbFactory?: AdbClientFactory;
  lastRenderedObservation?: PrototypeDisplayDependencies["lastRenderedObservation"];
  store?: PrototypeStatusStore;
  clock?: Pick<Timer, "now">;
  timer?: Timer;
  lifecycle?: PrototypeEventLifecycle;
  /** Retires the device's cached observation after a show or dismiss lands; tests inject a fake. */
  cacheInvalidator?: DeviceWindowCacheInvalidator;
  /** Captures the hierarchy element anchors resolve against; tests inject captured hierarchies. */
  anchorHierarchyCaptureFactory?: (device: BootedDevice) => HierarchyCapture;
}

export interface AnchorStage {
  /** The spec to send, element anchors replaced by bounds anchors; absent when unchanged. */
  spec?: PrototypeSpec;
  anchors?: ResolvedPrototypeAnchor[];
  hierarchyUpdatedAt?: number;
  failure?: PrototypeResult;
}

export interface PreflightStage extends AnchorStage {
  displayId?: number;
  chrome?: PrototypeWindowChrome;
}

export interface AssetStage {
  uploaded: UploadedPrototypeAsset[];
  /** The validated uploads, kept so a missing asset can be re-sent without re-reading its source. */
  prepared: PrototypeAssetUpload[];
  failure?: PrototypeResult;
}

export interface AssetReaders {
  env?: NodeJS.ProcessEnv;
  assetFileReader: PrototypeAssetFileReader;
  observationScreenshotReader: PrototypeObservationScreenshotReader;
}

export type PrototypeHandlerDependencies = {
  store: PrototypeStatusStore;
  events: PrototypeEventCoordinator;
  target: PrototypeTarget;
  assetReaders: AssetReaders;
  commits: PrototypeCommitGenerations;
  reverses: PrototypeAdbReverseManager;
  cacheInvalidator: DeviceWindowCacheInvalidator;
  now: () => number;
  timer?: Timer;
} & Pick<
  PrototypeToolDependencies,
  | "adbFactory"
  | "lastRenderedObservation"
  | "anchorHierarchyCaptureFactory"
  | "shaderAssetCache"
  | "env"
>;
export type PrototypeOutput = z.infer<typeof prototypeOutputSchema>;
