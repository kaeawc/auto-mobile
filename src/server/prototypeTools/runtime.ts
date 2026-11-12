import {
  createTestSessionRecorder,
  isHostLocalPrototypeAction,
  hostLocalPrototypeOutput,
} from "./testSession";
import type { PrototypeTestSessionRecorder } from "../../features/prototype/testSession/PrototypeTestSessionRecorder";
import { IosProtoViewer } from "../../features/prototype/protoViewer/IosProtoViewer";
import { DefaultIosProtoViewerSimctl } from "../../features/prototype/protoViewer/DefaultIosProtoViewerSimctl";
import { NodeIosProtoViewerFiles } from "../../features/prototype/protoViewer/NodeIosProtoViewerFiles";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { z } from "zod/v4";
import { deleteInternalToolParams } from "../../daemon/wire/constants";
import { defaultDaemonContext } from "../../daemon/daemonContext";
import { SessionReleaseBroadcaster } from "../../daemon/sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../../daemon/streamDeviceLifecycleEvents";
import { DefaultDeviceWindowCacheInvalidator } from "../../features/observe/DeviceWindowCacheInvalidator";
import { AndroidCtrlProxyClient } from "../../features/observe/android/AndroidCtrlProxyClient";
import type { PrototypeSpecRevisions } from "../../features/prototype/prototypeSpecRevisions";
import {
  daemonPrototypeSpecRevisions,
  setDaemonPrototypeShownSpecsReader,
} from "./daemonSpecRevisions";
import { MAX_MOCK_DOCUMENT_BYTES } from "../../features/prototype/prototypeMockSchema";
import { isMockBackendAction, mockBackendOutput } from "./mockBackend";
import { PrototypeMockBackendRegistry } from "../../features/prototype/PrototypeMockBackendRegistry";
import { PrototypeCommitGenerations } from "../../features/prototype/PrototypeCommitGenerations";
import { PrototypeEventCoordinator } from "../../features/prototype/PrototypeEventCoordinator";
import {
  InMemoryPrototypeStatusStore,
  type PrototypeScope,
  type PrototypeStatusStore,
} from "../../features/prototype/PrototypeStatusStore";
import type { PrototypeShownSpecs } from "../../features/prototype/PrototypeShownSpecs";
import {
  prototypeShaderOptInProblem,
  prototypeIosShaderProblem,
} from "../../features/prototype/prototypeShaders";
import { prototypeEventSource } from "../../features/prototype/PrototypeTransport";
import { AndroidPrototypeTransport } from "../../features/prototype/androidPrototypeTransport";
import {
  IosPrototypeTransport,
  noPrototypeAgentConnections,
  prototypeAgentNotConnectedMessage,
  type PrototypeAgentConnections,
} from "../../features/prototype/ios/iosPrototypeTransport";
import type { PrototypeAgentClient } from "../../features/prototype/ios/prototypeAgentClient";
import {
  buildPrototypeScreenMap,
  prototypeScreenMapMermaid,
} from "../../features/prototype/prototypeScreenMap";
import { savedAdbDependencies } from "../../features/prototype/pinConfirmation";
import {
  nodePrototypeAssetFileReader,
  type PrototypeAssetFileReader,
} from "../../features/prototype/prototypeAssetUploader";
import { prototypeSpecForDevice } from "../../features/prototype/prototypeComponents";
import * as requestWiring from "../../features/prototype/prototypeRequestWiring";
import * as channelWiring from "../../features/prototype/prototypeChannelWiring";
import { type PrototypeSpec } from "../../features/prototype/prototypeSpec";
import { NodeProtoViewerShareFiles } from "../../features/prototype/protoViewer/NodeProtoViewerShareFiles";
import {
  shareProtoViewerBundle,
  type ProtoViewerShareFiles,
} from "../../features/prototype/protoViewer/protoViewerShare";
import { readPrototypeSpecFile } from "../../features/prototype/prototypeSpecFile";
import { requestedPrototypeWindowOptions } from "../../features/prototype/prototypeWindowOptions";
import { prototypeSettingsPagePlatformError } from "../../features/prototype/prototypeSettings";
import { TelemetryRecorder } from "../../features/telemetry/TelemetryRecorder";
import {
  currentConnectionMcpSessionId,
  getToolSelectionContext,
} from "../../features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidProtoViewer } from "../../features/prototype/protoViewer/AndroidProtoViewer";
import type { ProtoViewerDevice } from "../../features/prototype/protoViewer/protoViewerDevice";
import { NodeProtoViewerTempFiles } from "../../features/prototype/protoViewer/NodeProtoViewerTempFiles";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../../utils/toolUtils";
import { readObservationScreenshotBytes } from "../observationResources";
import { subscribePrototypeCleanup, type PrototypeEventLifecycle } from "../prototypeLifecycle";
import { createPrototypePatchQueue, type PrototypePatchQueue } from "../prototypePatchAction";
import {
  createPrototypeSavedPlatformDispatch,
  dispatchPrototypeSavedAction,
  type PrototypeSavedErrorCode,
} from "../prototypeSavedActions";
import type { ProgressCallback } from "../toolRegistry";
import { stageAssets } from "./assets";
import {
  daemonPrototypePreviewBinding,
  isPrototypePreviewAction,
  prototypePreviewOutput,
  type PrototypePreviewBinding,
} from "./preview";
import {
  deviceRequestAction,
  isDeviceRequestAction,
  suspendedWaitWarning,
  waitForPrototypeEvent,
} from "./inspection";
import { performPrototypeAction } from "./mutation";
import { VirtualPrototypeDevice } from "../../features/prototype/headless/VirtualPrototypeDevice";
import {
  headlessPrototypeRefusal,
  isVirtualPrototypeDevice,
  virtualPrototypeDeviceReport,
} from "../../features/prototype/headless/headlessPrototypeMode";
import { prototypeOutputSchema, prototypeSchema, specProblem } from "./schemas";
import type {
  AssetReaders,
  PrototypeClient,
  PrototypeHandlerDependencies,
  PrototypeOutput,
  PrototypeTarget,
  PrototypeToolDependencies,
  PrototypeToolRuntime,
} from "./types";

function prototypeScope(
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
): PrototypeScope {
  const context = getToolSelectionContext();
  return {
    sessionUuid:
      args.sessionUuid ?? context?.routingSessionUuid ?? context?.toolSelectionProfileUuid,
    deviceId: device.deviceId,
  };
}

/** The MCP connection the call runs for (#17358); absent for a call with no connection. */
function callerMcpSessionId(): string | undefined {
  const id = currentConnectionMcpSessionId();
  return id && id.trim().length > 0 ? id : undefined;
}

/**
 * A show or patch that landed reports the MCP connection its spec revision is recorded under, so a
 * client can filter the shared revision history to its own (#17358).
 */
export function attributeRevision<T extends { success: boolean }>(
  output: T,
  action: string,
  mcpSessionId: string | undefined = callerMcpSessionId(),
): T & { mcpSessionId?: string } {
  return (action === "show" || action === "patch") && output.success && mcpSessionId
    ? { ...output, mcpSessionId }
    : output;
}

function mutationCallOptions(
  scope: PrototypeScope,
  queue: PrototypePatchQueue,
  signal: AbortSignal | undefined,
) {
  return {
    scope,
    queue,
    signal: combineWithAmbientAbort(signal),
    mcpSessionId: callerMcpSessionId(),
  };
}

const responseFor = (payload: z.infer<typeof prototypeOutputSchema>) =>
  withIsErrorOnFailure(createStructuredToolResponse(payload), payload.success);

/** A result from the headless virtual device says so, with the capabilities it cannot emulate. */
function responderFor(device: BootedDevice) {
  return isVirtualPrototypeDevice(device)
    ? (payload: z.infer<typeof prototypeOutputSchema>) =>
        responseFor({ ...payload, virtualDevice: virtualPrototypeDeviceReport() })
    : responseFor;
}

function prototypeDeviceUnboundSource(): object | undefined {
  return defaultDaemonContext.sessionManager();
}

function subscribePrototypeDeviceUnbound(
  listener: (deviceId: string) => void,
): (() => void) | undefined {
  const manager = defaultDaemonContext.sessionManager();
  if (!manager) {
    // The shared host is created before startDaemon initialises DaemonState; the host retries.
    return undefined;
  }
  // This removable hook observes the same rebind as onSessionDeviceUnbound,
  // including a forced same-serial replacement, without retaining callbacks.
  return manager.onDeviceOwnershipChange((deviceId, invalidation) => {
    if (invalidation === "full" || manager.getSessionForDevice(deviceId) === null) {
      listener(deviceId);
    }
  });
}

/**
 * Inputs only CtrlProxy can honour, refused before any device request. iOS simulators run the
 * injected prototype agent: no display.
 */
function prototypePlatformError(
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
): (ActionableError & { errorCode?: PrototypeSavedErrorCode }) | undefined {
  if (device.platform === "android") {
    return undefined;
  }
  if (device.platform !== "ios") {
    return new ActionableError(
      "Prototypes need an Android device or an iOS simulator. Target one with deviceId or sessionUuid.",
    );
  }
  const shaderProblem = prototypeIosShaderProblem(args.spec, args.assets);
  if (shaderProblem) {
    return new ActionableError(shaderProblem);
  }
  if (args.display !== undefined) {
    return new ActionableError("display is Android only; omit display on iOS.");
  }
  if (args.spec !== undefined) {
    const options = requestedPrototypeWindowOptions(args.spec as PrototypeSpec);
    // window.layer "app" is accepted and ignored on iOS, silently (owner decision 2026-10-09): the
    // agent's window level is fixed, so one spec runs on both platforms.
    if (options.devicePersistence) {
      return new ActionableError('window.persistence "device" is Android only; omit it on iOS.');
    }
    // Only a spec that runs or is saved for the device needs the page; screenMap is host-only.
    const settingsPage =
      args.action === "show" || args.action === "save"
        ? prototypeSettingsPagePlatformError(args.spec, "ios")
        : undefined;
    if (settingsPage) {
      return new ActionableError(
        `Invalid prototype at spec.${settingsPage.path}: ${settingsPage.message}. Nothing was shown.`,
      );
    }
  }
  return undefined;
}

/** Components are expanded on the host (#11053): everything past validation sees plain nodes. */
function withExpandedSpec<T extends { spec?: z.infer<typeof prototypeSchema>["spec"] }>(
  args: T,
): T {
  return args.spec === undefined ? args : { ...args, spec: prototypeSpecForDevice(args.spec) };
}

/** ProtoViewer over adb on the device's own executor (#13621). */
function defaultProtoViewerFactory(
  dependencies: Pick<PrototypeToolDependencies, "adbFactory" | "timer">,
): (device: BootedDevice) => ProtoViewerDevice {
  return (device) =>
    device.platform === "ios"
      ? new IosProtoViewer({
          deviceId: device.deviceId,
          simctl: new DefaultIosProtoViewerSimctl(new SimCtlClient()),
          files: new NodeIosProtoViewerFiles(),
          timer: dependencies.timer ?? defaultTimer,
          ids: defaultIdGenerator,
        })
      : new AndroidProtoViewer({
          adb: (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
          timer: dependencies.timer ?? defaultTimer,
          ids: defaultIdGenerator,
          tempFiles: new NodeProtoViewerTempFiles(),
        });
}

function defaultPrototypeLifecycle(): PrototypeEventLifecycle {
  return {
    subscribeSessionRelease: (listener) =>
      SessionReleaseBroadcaster.subscribe((sessionUuid, _reason, snapshot, extras) =>
        // An upgrade-only re-announcement's device may belong to its next owner by now (#11206):
        // clear the released session's own state only.
        listener(sessionUuid, extras?.upgradeOnly ? undefined : snapshot?.deviceId),
      ),
    subscribeDeviceRemoval: (listener) =>
      getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved(listener),
    subscribeDeviceUnbound: subscribePrototypeDeviceUnbound,
    deviceUnboundSource: prototypeDeviceUnboundSource,
  };
}

/** Transports cached per underlying client; shared with the host that owns the subscriptions. */
interface PrototypeTransportCache {
  android: WeakMap<PrototypeClient, AndroidPrototypeTransport>;
  ios: WeakMap<PrototypeAgentClient, IosPrototypeTransport>;
  requests?: requestWiring.PrototypeRequestCoordinator;
  channels?: channelWiring.PrototypeChannelCoordinator;
}

/**
 * One transport per underlying client keeps the coordinator's per-device event subscription
 * stable across calls and across MCP connections, exactly as when it subscribed to the client.
 */
function prototypeTargets(
  clientFactory: (device: BootedDevice) => PrototypeClient,
  agentConnections: PrototypeAgentConnections,
  transports: PrototypeTransportCache,
): {
  androidTarget: (device: BootedDevice) => PrototypeTarget;
  iosTarget: (device: BootedDevice) => PrototypeTarget | undefined;
} {
  const androidTarget = (device: BootedDevice): PrototypeTarget => {
    const client = clientFactory(device);
    let transport = transports.android.get(client);
    if (transport === undefined) {
      transport = new AndroidPrototypeTransport(client);
      transports.android.set(client, transport);
      requestWiring.attachAndroidPrototypeRequests(client, device.deviceId, transports.requests);
      channelWiring.attachAndroidPrototypeChannels(client, device.deviceId, transports.channels);
    }
    return { transport, android: transport };
  };
  const iosTarget = (device: BootedDevice): PrototypeTarget | undefined => {
    const agent = agentConnections.get(device.deviceId);
    if (agent === undefined) {
      return undefined;
    }
    let transport = transports.ios.get(agent);
    if (transport === undefined) {
      transport = new IosPrototypeTransport(agent);
      transports.ios.set(agent, transport);
      requestWiring.attachIosPrototypeRequests(agent, device.deviceId, transports.requests);
      channelWiring.attachIosPrototypeChannels(agent, device.deviceId, transports.channels);
    }
    return { transport, ios: transport };
  };
  return { androidTarget, iosTarget };
}

function prototypeClock(dependencies: PrototypeToolDependencies): Pick<Timer, "now"> {
  return dependencies.clock ?? dependencies.timer ?? defaultTimer;
}

/**
 * Host-side prototype state: status, event buffers, commit generations and transports. The daemon
 * re-registers the tool for every MCP connection, so this state must outlive any one handler.
 */
interface PrototypeHost {
  recorder: PrototypeTestSessionRecorder;
  store: PrototypeStatusStore;
  events: PrototypeEventCoordinator;
  commits: PrototypeCommitGenerations;
  patchQueue: PrototypePatchQueue;
  transports: PrototypeTransportCache;
  /** Declarative mock backends of this session (#14271). */
  mocks: PrototypeMockBackendRegistry;
  /** The headless virtual device (#17974); holds state only while headless calls use it. */
  virtualDevice: VirtualPrototypeDevice;
  /** Subscribes any lifecycle hook that was not yet available; a no-op once all are active. */
  ensureLifecycle(): void;
  dispose(): void;
}

function createPrototypeHost(
  dependencies: PrototypeToolDependencies,
  specRevisions?: PrototypeSpecRevisions,
): PrototypeHost {
  const store =
    dependencies.store ??
    new InMemoryPrototypeStatusStore(prototypeClock(dependencies), undefined, specRevisions);
  const timer = dependencies.timer ?? defaultTimer;
  const mocks = new PrototypeMockBackendRegistry({
    ids: dependencies.idGenerator ?? defaultIdGenerator,
    timer,
  });
  const requests = requestWiring.createPrototypeRequestCoordinator(timer, mocks);
  const channels = channelWiring.createPrototypeChannelCoordinator(
    timer,
    mocks,
    dependencies.channelExecutor,
  );
  const recorder = createTestSessionRecorder(dependencies, store);
  const events = new PrototypeEventCoordinator(timer, store, {
    telemetry: TelemetryRecorder.getInstance(),
    requests: channelWiring.combinedPrototypeCancellation(requests, channels),
    recorder,
  });
  const cleanup = subscribePrototypeCleanup(
    dependencies.lifecycle ?? defaultPrototypeLifecycle(),
    events,
  );
  let disposed = false;
  return {
    store,
    events,
    recorder,
    commits: new PrototypeCommitGenerations(),
    patchQueue: createPrototypePatchQueue(),
    transports: { android: new WeakMap(), ios: new WeakMap(), requests, channels },
    mocks,
    virtualDevice:
      dependencies.virtualDevice ?? new VirtualPrototypeDevice(prototypeClock(dependencies)),
    ensureLifecycle: cleanup.ensureSubscribed,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        cleanup.unsubscribe();
        events.dispose();
        mocks.clearAll();
      }
    },
  };
}

/** The daemon-process host every default registration (one per MCP connection) shares. */
let daemonPrototypeHost: PrototypeHost | undefined;
let activeRegistration: { host: PrototypeHost; dispose: () => void } | undefined;

/**
 * Injecting any piece of host state (store, clock, timer, lifecycle) asks for a private host owned
 * by that registration; otherwise every registration shares the daemon host, so a second MCP
 * connection keeps the first one's status and pending events (keyed by session and device).
 */
function prototypeHostFor(dependencies: PrototypeToolDependencies): PrototypeHost {
  const { store, clock, timer, lifecycle } = dependencies;
  if (
    store ||
    clock ||
    timer ||
    lifecycle ||
    dependencies.testSessionStore ||
    dependencies.idGenerator ||
    dependencies.channelExecutor ||
    dependencies.virtualDevice
  ) {
    return createPrototypeHost(dependencies);
  }
  daemonPrototypeHost ??= createPrototypeHost(dependencies, daemonPrototypeSpecRevisions());
  return daemonPrototypeHost;
}

/** Specs the shared daemon host has seen acknowledged, for read-only resources (#13729). */
export function daemonPrototypeShownSpecs(): PrototypeShownSpecs | undefined {
  return daemonPrototypeHost?.store.shownSpecs;
}
setDaemonPrototypeShownSpecsReader(daemonPrototypeShownSpecs);

/**
 * A private host is disposed with its registration. The shared host is disposed only by the
 * registration currently installed: an older connection's disposer must not wipe it.
 */
function prototypeRegistrationDisposer(host: PrototypeHost): () => void {
  const dispose = () => {
    const active = activeRegistration?.dispose === dispose;
    if (active) {
      activeRegistration = undefined;
    }
    if (host !== daemonPrototypeHost) {
      host.dispose();
    } else if (active) {
      host.dispose();
      daemonPrototypeHost = undefined;
    }
  };
  return dispose;
}

/** Parses the caller's arguments after the daemon's internal routing fields are removed. */
function parsePrototypeInput(input: unknown) {
  const external: Record<string, unknown> =
    input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  deleteInternalToolParams(external);
  return prototypeSchema.safeParse(external);
}

/**
 * A show with `specPath` becomes a show with the file's spec, validated like an inline one, before
 * anything else looks at the arguments; the path goes no further than this function.
 */
async function withSpecFromPath(
  args: z.infer<typeof prototypeSchema>,
  reader: PrototypeAssetFileReader,
  signal: AbortSignal | undefined,
): Promise<{ args: z.infer<typeof prototypeSchema> } | { error: string }> {
  const withSpec = await specFromPath(args, reader, signal);
  return "error" in withSpec ? withSpec : mockFromPath(withSpec.args, reader, signal);
}

async function specFromPath(
  args: z.infer<typeof prototypeSchema>,
  reader: PrototypeAssetFileReader,
  signal: AbortSignal | undefined,
): Promise<{ args: z.infer<typeof prototypeSchema> } | { error: string }> {
  if (args.specPath === undefined || !takesSpecPath(args.action)) {
    return { args };
  }
  const { specPath, ...rest } = args;
  const read = await readPrototypeSpecFile(specPath, reader);
  signal?.throwIfAborted();
  if ("error" in read) {
    return read;
  }
  const problem = specProblem(read.json);
  if (problem) {
    return { error: `specPath ${specPath}: ${problem.path}: ${problem.text}` };
  }
  return { args: { ...rest, spec: read.json } };
}

const takesSpecPath = (action: string): boolean =>
  action === "show" || action === "screenMap" || action === "share";

/** A show with `mockPath` becomes a show with the file's `{backendId: definition}` as `mock`. */
async function mockFromPath(
  args: z.infer<typeof prototypeSchema>,
  reader: PrototypeAssetFileReader,
  signal: AbortSignal | undefined,
): Promise<{ args: z.infer<typeof prototypeSchema> } | { error: string }> {
  if (args.mockPath === undefined) {
    return { args };
  }
  const { mockPath, ...rest } = args;
  const read = await readPrototypeSpecFile(mockPath, reader, {
    label: "mockPath",
    maxBytes: MAX_MOCK_DOCUMENT_BYTES,
  });
  signal?.throwIfAborted();
  if ("error" in read) {
    return read;
  }
  const document = read.json;
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { error: `mockPath ${mockPath}: expected an object of {backendId: definition}` };
  }
  return { args: { ...rest, mock: { ...document } } };
}

/** Keep expansion and the host opt-in ahead of every spec-consuming route, including save. */
function expandedPrototypeInput(
  loaded: Awaited<ReturnType<typeof withSpecFromPath>>,
  device: BootedDevice,
  env: NodeJS.ProcessEnv | undefined,
  mocks: PrototypeMockBackendRegistry,
): Awaited<ReturnType<typeof withSpecFromPath>> {
  if ("error" in loaded) {
    return loaded;
  }
  // The headless virtual device refuses what only a real device can do, before anything runs.
  const headlessRefusal = isVirtualPrototypeDevice(device)
    ? headlessPrototypeRefusal(loaded.args)
    : undefined;
  if (headlessRefusal) {
    return { error: headlessRefusal };
  }
  const args = withExpandedSpec(loaded.args);
  const error = device.platform === "ios" ? undefined : prototypeShaderOptInProblem(args.spec, env);
  return error ? { error } : defineShowMocks(args, mocks);
}

/** The mock backends a show carries are defined once the spec is accepted, before it is sent. */
function defineShowMocks(
  args: z.infer<typeof prototypeSchema>,
  mocks: PrototypeMockBackendRegistry,
): { args: z.infer<typeof prototypeSchema> } | { error: string } {
  if (args.mock === undefined) {
    return { args };
  }
  try {
    mocks.defineAll(args.mock);
  } catch (error) {
    logger.warn("Prototype show mock definition failed", error);
    return { error: toActionableError(error, "Mock backend definition failed").message };
  }
  return { args };
}

/** Only a spec read from a file awaits: every other call keeps its timing against FakeTimer. */
function readsSpecFile(args: z.infer<typeof prototypeSchema>): boolean {
  return (
    (takesSpecPath(args.action) && args.specPath !== undefined) ||
    (args.action === "show" && args.mockPath !== undefined)
  );
}

type HostOnlyAction =
  | "screenMap"
  | "share"
  | "defineBackend"
  | "clearBackend"
  | "backendLog"
  | "publish"
  | "serve"
  | "stop";

const isHostOnlyAction = (action: string): action is HostOnlyAction =>
  action === "screenMap" ||
  action === "share" ||
  isMockBackendAction(action) ||
  isPrototypePreviewAction(action);

/** Actions answered by the host alone, before any device or scope is involved. */
async function hostOnlyOutput(
  host: { mocks: PrototypeMockBackendRegistry; preview: () => PrototypePreviewBinding },
  args: z.infer<typeof prototypeSchema>,
  readers: AssetReaders,
  shareFiles: ProtoViewerShareFiles | undefined,
): Promise<PrototypeOutput> {
  if (args.action === "share") {
    return await shareOutput(args, readers, shareFiles);
  }
  if (isPrototypePreviewAction(args.action)) {
    return await prototypePreviewOutput(host.preview(), args);
  }
  return args.action === "screenMap"
    ? screenMapOutput(args.spec)
    : mockBackendOutput(host.mocks, args);
}

/** share writes local files only: the spec was validated, and no device or scope is involved. */
async function shareOutput(
  args: z.infer<typeof prototypeSchema>,
  readers: AssetReaders,
  files: ProtoViewerShareFiles = new NodeProtoViewerShareFiles(),
) {
  return await shareProtoViewerBundle(
    { spec: args.spec as PrototypeSpec, assets: args.assets, url: args.url },
    {
      assetFileReader: readers.assetFileReader,
      observationScreenshotReader: readers.observationScreenshotReader,
      files,
    },
  );
}

function screenMapOutput(spec: unknown) {
  const map = buildPrototypeScreenMap(spec);
  return { success: true, screenMap: map, mermaid: prototypeScreenMapMermaid(map) };
}

/**
 * The prototype tool's implementation for one registration (#17709): the handler and the disposer
 * of the host state it uses. `registration.ts` imports this module on the tool's first call.
 */
export function createPrototypeToolRuntime(
  dependencies: PrototypeToolDependencies = {},
): PrototypeToolRuntime {
  const host = prototypeHostFor(dependencies);
  // Replacing a registration that used a different host makes that host's state obsolete.
  if (activeRegistration && activeRegistration.host !== host) {
    activeRegistration.dispose();
  }
  // Per-connection registrations run after DaemonState initialises: pick up the unbound hook.
  host.ensureLifecycle();
  const { store, events, commits } = host;
  const deviceClientFactory =
    dependencies.clientFactory ??
    ((device: BootedDevice) => AndroidCtrlProxyClient.getInstance(device));
  const clientFactory = (device: BootedDevice): PrototypeClient =>
    isVirtualPrototypeDevice(device) ? host.virtualDevice : deviceClientFactory(device);
  const agentConnections = dependencies.agentConnections ?? noPrototypeAgentConnections;
  const { androidTarget, iosTarget } = prototypeTargets(
    clientFactory,
    agentConnections,
    host.transports,
  );
  const cacheInvalidator =
    dependencies.cacheInvalidator ?? new DefaultDeviceWindowCacheInvalidator();
  const clock = prototypeClock(dependencies);
  const assetReaders: AssetReaders = {
    env: dependencies.env,
    assetFileReader: dependencies.assetFileReader ?? nodePrototypeAssetFileReader,
    observationScreenshotReader:
      dependencies.observationScreenshotReader ?? readObservationScreenshotBytes,
  };
  const savedPlatformDispatch = createPrototypeSavedPlatformDispatch({
    ...assetReaders,
    installer: dependencies.iosSavedPrototypeInstaller,
    protoViewer: dependencies.protoViewerFactory ?? defaultProtoViewerFactory(dependencies),
  });
  // Resolved on first use: building the daemon's (unbound) server is deferred until a call needs it.
  const preview = () => dependencies.preview ?? daemonPrototypePreviewBinding();
  const handler = async (
    device: BootedDevice,
    input: unknown,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    host.ensureLifecycle();
    const respond = responderFor(device);
    const parsed = parsePrototypeInput(input);
    if (!parsed.success) {
      return respond({
        success: false,
        error: `Invalid prototype input: ${parsed.error.message}`,
      });
    }
    // Only a specPath show awaits here: other calls keep their timing against FakeTimer.
    const loaded = readsSpecFile(parsed.data)
      ? await withSpecFromPath(parsed.data, assetReaders.assetFileReader, signal)
      : { args: parsed.data };
    const prepared = expandedPrototypeInput(loaded, device, dependencies.env, host.mocks);
    if ("error" in prepared) {
      return respond({ success: false, error: prepared.error });
    }
    const args = prepared.args;
    const platformResult = savedPlatformDispatch(
      device,
      { ...args, spec: args.spec as PrototypeSpec | undefined },
      combineWithAmbientAbort(signal),
      () => prototypePlatformError(device, args),
    );
    if (platformResult) {
      // A ProtoViewer-routed save settles undefined when ProtoViewer is absent: keep today's path.
      const settled = await platformResult;
      if (settled) {
        return respond(settled);
      }
    }
    if (isHostOnlyAction(args.action)) {
      const shareFiles = dependencies.protoViewerShareFiles;
      const hostOnly = { mocks: host.mocks, preview };
      return respond(await hostOnlyOutput(hostOnly, args, assetReaders, shareFiles));
    }
    const scope = prototypeScope(device, args);
    if (isHostLocalPrototypeAction(args.action)) {
      const local = { recorder: host.recorder, store, events, preview: () => preview().server };
      return respond(await hostLocalPrototypeOutput(local, scope, args));
    }
    const target = device.platform === "android" ? androidTarget(device) : iosTarget(device);
    if (!target) {
      const error = new ActionableError(prototypeAgentNotConnectedMessage(device.deviceId));
      return respond({ success: false, error: error.message });
    }
    const { action } = args;
    if (isDeviceRequestAction(action)) {
      const host = { store, events };
      return respond(await deviceRequestAction(args, host, device, { target, scope, signal }));
    }
    if (action === "awaitEvent") {
      const source = prototypeEventSource(target.transport);
      const waited = await waitForPrototypeEvent(events, scope, source, {
        query: args,
        context: { progress, signal },
      });
      return respond({
        success: true,
        ...waited,
        ...suspendedWaitWarning(store, scope, args.id, waited),
      });
    }
    const handlerDependencies: PrototypeHandlerDependencies = {
      store,
      events,
      target,
      assetReaders,
      commits,
      cacheInvalidator,
      now: () => clock.now(),
      timer: dependencies.timer,
      adbFactory: dependencies.adbFactory,
      lastRenderedObservation: dependencies.lastRenderedObservation,
      anchorHierarchyCaptureFactory: dependencies.anchorHierarchyCaptureFactory,
      screenRoundFactory: dependencies.screenRoundFactory,
      shaderAssetCache: dependencies.shaderAssetCache,
      env: dependencies.env,
    };
    const dispatched = await dispatchPrototypeSavedAction(
      { ...args, action, spec: args.spec as PrototypeSpec | undefined },
      () => {
        const savedSignal = combineWithAmbientAbort(signal);
        return {
          client: target.android!,
          ...savedAdbDependencies(device, dependencies),
          signal: savedSignal,
          stageAssets: () => stageAssets(target, args, assetReaders, { signal: savedSignal }),
        };
      },
      (action) =>
        performPrototypeAction(
          handlerDependencies,
          device,
          { ...args, action },
          mutationCallOptions(scope, host.patchQueue, signal),
        ),
    );
    return respond(attributeRevision(dispatched, action));
  };
  const dispose = prototypeRegistrationDisposer(host);
  activeRegistration = { host, dispose };
  return { handler, dispose };
}
