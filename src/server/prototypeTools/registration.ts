import { PROTOTYPE_TOOL_NAME } from "./schemas";
import { z } from "zod/v4";
import { deleteInternalToolParams } from "../../daemon/constants";
import { defaultDaemonContext } from "../../daemon/daemonContext";
import { SessionReleaseBroadcaster } from "../../daemon/sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../../daemon/streamDeviceLifecycleEvents";
import { DefaultDeviceWindowCacheInvalidator } from "../../features/observe/DeviceWindowCacheInvalidator";
import { AndroidCtrlProxyClient } from "../../features/observe/android/AndroidCtrlProxyClient";
import { PrototypeAdbReverseManager } from "../../features/prototype/PrototypeAdbReverseManager";
import { PrototypeCommitGenerations } from "../../features/prototype/PrototypeCommitGenerations";
import { PrototypeEventCoordinator } from "../../features/prototype/PrototypeEventCoordinator";
import {
  InMemoryPrototypeStatusStore,
  type PrototypeScope,
  type PrototypeStatusStore,
} from "../../features/prototype/PrototypeStatusStore";
import type { PrototypeShownSpecs } from "../../features/prototype/PrototypeShownSpecs";
import { prototypeEventSource } from "../../features/prototype/PrototypeTransport";
import { AndroidPrototypeTransport } from "../../features/prototype/androidPrototypeTransport";
import {
  IosPrototypeTransport,
  noPrototypeAgentConnections,
  prototypeAgentNotConnectedMessage,
  type PrototypeAgentConnections,
} from "../../features/prototype/ios/iosPrototypeTransport";
import type { PrototypeAgentClient } from "../../features/prototype/ios/prototypeAgentClient";
import { savedAdbDependencies } from "../../features/prototype/pinConfirmation";
import {
  nodePrototypeAssetFileReader,
  type PrototypeAssetFileReader,
} from "../../features/prototype/prototypeAssetUploader";
import { prototypeSpecForDevice } from "../../features/prototype/prototypeComponents";
import * as requestWiring from "../../features/prototype/prototypeRequestWiring";
import { type PrototypeSpec } from "../../features/prototype/prototypeSpec";
import { readPrototypeSpecFile } from "../../features/prototype/prototypeSpecFile";
import { requestedPrototypeWindowOptions } from "../../features/prototype/prototypeWindowOptions";
import { TelemetryRecorder } from "../../features/telemetry/TelemetryRecorder";
import { getToolSelectionContext } from "../../features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  AndroidProtoViewer,
  type ProtoViewerDevice,
} from "../../features/prototype/protoViewer/AndroidProtoViewer";
import { NodeProtoViewerTempFiles } from "../../features/prototype/protoViewer/NodeProtoViewerTempFiles";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../../utils/toolUtils";
import { readObservationScreenshotBytes } from "../observationResources";
import { subscribePrototypeCleanup, type PrototypeEventLifecycle } from "../prototypeLifecycle";
import { createPrototypePatchQueue, type PrototypePatchQueue } from "../prototypePatchAction";
import { withSavedReverses } from "../prototypeReverse";
import {
  createPrototypeSavedPlatformDispatch,
  dispatchPrototypeSavedAction,
  type PrototypeSavedErrorCode,
} from "../prototypeSavedActions";
import type { ProgressCallback } from "../toolRegistry";
import { ToolRegistry } from "../toolRegistry";
import { stageAssets } from "./assets";
import {
  deviceRequestAction,
  isDeviceRequestAction,
  statusOutput,
  suspendedWaitWarning,
  waitForPrototypeEvent,
} from "./inspection";
import { performPrototypeAction } from "./mutation";
import {
  isPrototypeReadAction,
  PROTOTYPE_READ_ACTIONS,
  prototypeOutputSchema,
  prototypeSchema,
  specProblem,
} from "./schemas";
import type {
  AssetReaders,
  PrototypeClient,
  PrototypeHandlerDependencies,
  PrototypeTarget,
  PrototypeToolDependencies,
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

const responseFor = (payload: z.infer<typeof prototypeOutputSchema>) =>
  withIsErrorOnFailure(createStructuredToolResponse(payload), payload.success);

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
    new AndroidProtoViewer({
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
  store: PrototypeStatusStore;
  events: PrototypeEventCoordinator;
  commits: PrototypeCommitGenerations;
  patchQueue: PrototypePatchQueue;
  transports: PrototypeTransportCache;
  /** `adb reverse` ownership for via "device" request ports (#12530). */
  reverses: PrototypeAdbReverseManager;
  /** Subscribes any lifecycle hook that was not yet available; a no-op once all are active. */
  ensureLifecycle(): void;
  dispose(): void;
}

function createPrototypeHost(dependencies: PrototypeToolDependencies): PrototypeHost {
  const store =
    dependencies.store ?? new InMemoryPrototypeStatusStore(prototypeClock(dependencies));
  const timer = dependencies.timer ?? defaultTimer;
  const requests = requestWiring.createPrototypeRequestCoordinator(timer);
  const events = new PrototypeEventCoordinator(
    timer,
    store,
    TelemetryRecorder.getInstance(),
    requests,
  );
  const reverses = new PrototypeAdbReverseManager();
  const cleanup = subscribePrototypeCleanup(
    dependencies.lifecycle ?? defaultPrototypeLifecycle(),
    events,
    reverses,
  );
  let disposed = false;
  return {
    store,
    events,
    commits: new PrototypeCommitGenerations(),
    patchQueue: createPrototypePatchQueue(),
    transports: { android: new WeakMap(), ios: new WeakMap(), requests },
    reverses,
    ensureLifecycle: cleanup.ensureSubscribed,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        cleanup.unsubscribe();
        events.dispose();
        void reverses.dispose();
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
  if (store || clock || timer || lifecycle) {
    return createPrototypeHost(dependencies);
  }
  daemonPrototypeHost ??= createPrototypeHost(dependencies);
  return daemonPrototypeHost;
}

/** Specs the shared daemon host has seen acknowledged, for read-only resources (#13729). */
export function daemonPrototypeShownSpecs(): PrototypeShownSpecs | undefined {
  return daemonPrototypeHost?.store.shownSpecs;
}

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
  if (args.action !== "show" || args.specPath === undefined) {
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

export function registerPrototypeTools(dependencies: PrototypeToolDependencies = {}): () => void {
  const host = prototypeHostFor(dependencies);
  // Replacing a registration that used a different host makes that host's state obsolete.
  if (activeRegistration && activeRegistration.host !== host) {
    activeRegistration.dispose();
  }
  // Per-connection registrations run after DaemonState initialises: pick up the unbound hook.
  host.ensureLifecycle();
  const { store, events, commits, reverses } = host;
  const clientFactory =
    dependencies.clientFactory ??
    ((device: BootedDevice) => AndroidCtrlProxyClient.getInstance(device));
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
    assetFileReader: dependencies.assetFileReader ?? nodePrototypeAssetFileReader,
    observationScreenshotReader:
      dependencies.observationScreenshotReader ?? readObservationScreenshotBytes,
  };
  const savedPlatformDispatch = createPrototypeSavedPlatformDispatch({
    ...assetReaders,
    installer: dependencies.iosSavedPrototypeInstaller,
    protoViewer: dependencies.protoViewerFactory ?? defaultProtoViewerFactory(dependencies),
  });
  const handler = async (
    device: BootedDevice,
    input: unknown,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    host.ensureLifecycle();
    const parsed = parsePrototypeInput(input);
    if (!parsed.success) {
      return responseFor({
        success: false,
        error: `Invalid prototype input: ${parsed.error.message}`,
      });
    }
    // Only a specPath show awaits here: other calls keep their timing against FakeTimer.
    const loaded =
      parsed.data.action === "show" && parsed.data.specPath !== undefined
        ? await withSpecFromPath(parsed.data, assetReaders.assetFileReader, signal)
        : { args: parsed.data };
    if ("error" in loaded) {
      return responseFor({ success: false, error: loaded.error });
    }
    const args = withExpandedSpec(loaded.args);
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
        return responseFor(settled);
      }
    }
    const scope = prototypeScope(device, args);
    if (args.action === "status") {
      return responseFor({
        success: true,
        ...statusOutput(store, events, scope, { deviceDark: "cached" }),
      });
    }
    const target = device.platform === "android" ? androidTarget(device) : iosTarget(device);
    if (!target) {
      const error = new ActionableError(prototypeAgentNotConnectedMessage(device.deviceId));
      return responseFor({ success: false, error: error.message });
    }
    const { action } = args;
    if (isDeviceRequestAction(action)) {
      const host = { store, events, reverses };
      return responseFor(await deviceRequestAction(args, host, device, target, scope, signal));
    }
    if (action === "awaitEvent") {
      const source = prototypeEventSource(target.transport);
      const waited = await waitForPrototypeEvent(events, scope, source, args, { progress, signal });
      return responseFor({
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
      reverses,
      cacheInvalidator,
      now: () => clock.now(),
      timer: dependencies.timer,
      adbFactory: dependencies.adbFactory,
      lastRenderedObservation: dependencies.lastRenderedObservation,
      anchorHierarchyCaptureFactory: dependencies.anchorHierarchyCaptureFactory,
    };
    const dispatched = await withSavedReverses(handlerDependencies, device, args, () =>
      dispatchPrototypeSavedAction(
        { ...args, action, spec: args.spec as PrototypeSpec | undefined },
        () => {
          const savedSignal = combineWithAmbientAbort(signal);
          return {
            client: target.android!,
            ...savedAdbDependencies(device, dependencies),
            signal: savedSignal,
            stageAssets: () => stageAssets(target, args, assetReaders, savedSignal),
          };
        },
        (action) =>
          performPrototypeAction(
            handlerDependencies,
            device,
            { ...args, action },
            scope,
            host.patchQueue,
            combineWithAmbientAbort(signal),
          ),
      ),
    );
    return responseFor(dispatched);
  };
  ToolRegistry.registerDeviceAware(
    PROTOTYPE_TOOL_NAME,
    'Show (always a full spec, inline as spec or from a local JSON file as specPath), patch (id and ops), dismiss (id or all:true), status (host-local, no device request), inspect (asks the device which prototypes it is showing and adopts them into status and awaitEvent; use it after a session release or reconnect), or awaitEvent for a prototype id on Android, or on an iOS simulator through the prototype agent that launchApp with prototype:true injects (show, patch, dismiss, status, inspect, awaitEvent; sizes are points). save (spec/assets/label/icon), listSaved and deleteSaved (id) need prototype_saved_v1 on Android, or an iOS simulator (no agent needed) using the verified viewer template (or AUTOMOBILE_IOS_PROTOTYPE_VIEWER) for save; icon is an asset uploaded in the same call. On Android, save with pin:true then asks the launcher to pin a shortcut (pinned: pinned|pending|unsupported; pending until the launcher dialog is accepted (autoConfirm taps it), declining sends nothing); deleteSaved disables the shortcut, and removeIcon:true clears it with adb only when no saved prototype remains. iOS installs an app icon on the home screen and ignores pin. iOS listSaved ids are bundle ids accepted by deleteSaved and omit savedAt. On Android with the ProtoViewer app installed, save without pin or icon imports the spec and its assets into the ProtoViewer library instead of CtrlProxy, and returns viewer {app, libraryId, label} plus a warning: ProtoViewer marks the entry imported, keeps its requests off until the user allows network in ProtoViewer, and does not attach it to this host (no awaitEvent, patch or inspect). open with id set to that libraryId launches it (Android only). A show with the id of the prototype already on screen replaces it in place: it keeps the display and each pager\'s page (clamped), while the new spec\'s state is authoritative (values the user changed by tapping are not carried over unless the spec includes them); reset:true starts fresh instead. patch changes the prototype already on screen without re-sending the spec: {action:"patch",id,ops:[...]} with ops add/replace/remove/test on /data (content, agent-owned) or /state/<key> (needs baseRevision; the device refuses with conflict if the user changed that key since), and replaceNode {id,node} for one node by id; use show for a new screen or a window, theme or root change. patch needs a device advertising prototype_patch_v1 and is refused otherwise: use show. To present alternatives, show one design, describe it and the others in chat (what each is, what changed, which you recommend), and show the next on request; or show one spec whose pager holds every design with a visible label per page. Ask the user in chat which they prefer; never wait on the device for a choice. awaitEvent returns one buffered event, supports eventName/kind and afterSequence, and times out successfully (timedOut:true); default 30000 ms, maximum 60000 ms. Input and state changes (text input, toggles, sliders etc.) arrive as kind emit with eventName change (there is no separate change kind), with payload {key,value} for one changed key or {keys,values} for severalBuffer: 64 events per session/device/id; overflow drops oldest and reports droppedCount. Lower-or-equal sequences are ignored, including late arrivals and reconnect replays. Nodes: box/row/column/flow/grid/carousel, text/image/icon/spacer/textField/searchBar, Material switch/checkbox/button/radioGroup/listItem/slider/chip/card/iconButton/fab/segmentedButton/topAppBar/divider/badge/progress/chart/dialog/snackbar/timePicker/datePicker bound to state keys, scroll/pager/stack/tabBar/bottomNav/bottomSheet; actions: emit/setPage/push/pop/popToRoot/replace/setState/toggle/increment/decrement/dismiss/setData/appendData/removeData/request. Stack {type:"stack",id,start,screens} needs prototype_stack_v1; only its top screen renders, and status/inspect report stacks {id:{path,depth}}. screen_changed has name = stack id and payload {screen,depth}. Reuse: a top-level components:{name:{root}} map placed with {type:"use",component,props} nodes, expanded on the host with {props.<field>} bound like repeat placeholders. Sizes and anchors use dp (points on iOS). A node\'s anchor {type:"element",selector:{elementId,text,testTag,container},alignment:cover|top|bottom|start|end,offset?} is resolved once at show against the app (the prototype excluded) and converted to dp with the display density (iOS bounds are already points); a missing, ambiguous or off-screen element fails the show, and the result reports anchors and hierarchyUpdatedAt (show again to re-anchor). {type:"bounds",bounds:{x,y,width,height}} is screen dp (screen points on iOS). Window placement: fullscreen/sheet/floating, window.opacity: 0-100 (default 100). window.chrome: none (default) or bar, fullscreen only: on a device advertising prototype_window_chrome_v1, none draws no host dismiss bar and fills the window including under the status bar (use safeAreaPadding on a top bar), and a two-finger long press (about 1 s) reveals a dismiss pill for 5 s; window.persistence: "device" defaults to bar. Without the capability the bar is kept, explicit none is refused, and lastResult.chrome says which was drawn. Example: {action:"show",spec:{id:"demo",window:{placement:{type:"fullscreen"},opacity:80},root:{type:"text",text:"Hello"}}}. show also accepts assets:[{id,path}] (absolute local PNG/JPEG/WebP file path, or a TTF/OTF font file referenced from style.fontFamily as {asset}) or [{id,observation}] (an observation screenshot URI) uploaded before the prototype is sent; image nodes reference the id. If the device reports supplied assets missing, they are re-uploaded and the prototype re-sent once; missingAssets and warning report what is still missing. Verify with observe; no screenshot is returned. A successful show or patch also returns accessibilityFindings, an advisory host-side lint (unlabeled controls, images and text fields, low text contrast in light and dark, tap targets under 48dp) with spec paths; it never refuses a show. On Android a session prototype is tied to the app it was shown over: while another app is in front it is hidden (state kept, no dismissed event, not in observe, layer "prototype" calls fail saying so) and it returns with the app; a device-persistent prototype is not tied to an app. Status makes no device request, marks a prototype suspended:true once an inspect finds it hidden that way (an awaitEvent that then times out warns), and includes pendingCount/lastSequence/droppedCount after events arrive. Device dismissed events remove shown status; the terminal event remains available until consumed or explicit show/dismiss. Awaiting consumes events; unmatched events remain buffered. Optional MCP progress reports wait start/finish without delaying the wait. Session release, device removal and unbinding clear buffers. A disconnect alone is not observed. window.layer: system (default, above system UI) or app (above apps only, so the shade, keyboard and screenshot preview draw over it; the daemon grants CtrlProxy SYSTEM_ALERT_WINDOW with appops first). window.persistence: session (default) or device: the prototype stays interactive after USB/adb disconnect and session end with no idle timeout, keeps its assets, and carries a visible Close control; remove it with that control, dismiss, or a new show. Both are Android only and need a CtrlProxy advertising prototype_window_options_v1. A device-persistent prototype keeps emitting taps, page changes and text input while no host is connected: the device buffers the last 200 events (oldest dropped, counted) and delivers them when a host connects or on inspect, with sequences continuing and no rewind; inspect returns deviceDroppedEvents. inspect needs a CtrlProxy advertising prototype_persistence_replay_v1 and is refused otherwise. On an iOS simulator inspect asks the agent (prototype_inspect_v1) for the one prototype it shows, with no suspended and no deviceDroppedEvents, and is refused with a relaunch hint on an older agent. Light and dark: show takes appearance device (default), light or dark, which pins what the system setting means for that show without changing the device; it replaces the system setting only (mode order: explicit theme.mode, then the flat theme.colors.background/surface luminance, then an opaque authored background, then appearance, else the device), and light or dark is refused unless the device advertises prototype_appearance_v1. Such a device reports appearance {mode, source, deviceDark} in the show result and per prototype in inspect; deviceDark (the device\'s own setting) appears only in those device answers. The host-local status reports mode and source only (kept current by appearance_changed events, which carry just mode and source), because the device can flip while a pinned mode stays put and then no event arrives; call inspect for the current deviceDark. It sends one appearance_changed event (match it with awaitEvent kind:"appearance_changed", not eventName: its name is null; payload {mode, source}) on any change of the resolved mode while shown (the device flipping, or prototype state changing an inferred mode), never for the show itself. If an appearance_changed event arrives while a show is in flight the host cannot order the two, so that status entry has no appearance until a later event or inspect states it. In a scrim slot only the scrim role gets alpha (0.4); other roles are drawn unchanged. row/listItem swipeActions {start?,end?,fullSwipe?} (1-3 {label,icon?,role?,color?,onTap} per side; not inside a horizontal pager or carousel) require prototype_swipe_actions_v1; revealed buttons are tagged <rowTag>.swipe.<index>. Flow/grid require prototype_flow_grid_v1; grid is non-lazy and never scrolls itself (wrap it in scroll). scroll.refresh {stateKey,onRefresh} (pull-to-refresh on a vertical scroll; stateKey is a boolean that shows the indicator) requires prototype_refresh_v1. carousel {itemWidth,variant?,itemSpacing?,children} (horizontal snapping row) and pager indicator "dots" require prototype_carousel_v1. Per-mode {light, dark} forms need prototype_theme_modes_v1. Stack {type:"stack",id,start,screens} requires prototype_stack_v1 and is refused otherwise. Data, repeat.items {path}, repeat.key, {data:/pointer} text and {data: pointer} conditions require prototype_data_model_v1. setData {path,value}, appendData {path,value} and removeData {path} (path is /data/<pointer>, with a whole {index} segment inside a repeat; value is {value: json}, {state: key}, {data: pointer}, or {item: field}/{index: true} in a repeat) change /data from a tap and require prototype_data_actions_v1. Each device write is a change event (awaitEvent kind:"change") with name = the written /data path and payload {op, value?, revision}; once the device has written a prototype\'s data, a patch with /data ops needs baseRevision (the latest revision seen) and is refused with conflict {revision, state, data} if a newer write touched an overlapping path. request {url, method?, headers?, query?, body?, into?, statusKey?, via?, timeoutMs?, onSuccess?, onError?} calls any absolute http(s) URL from a tap (no host allowlist; url takes {key} and {data:/pointer} placeholders; headers/query values and body are literals or {state}/{data}/{value}/{item} bindings) and needs prototype_network_v1, plus prototype_network_device_v1 for via "device" (default via "host": the host makes the call). A 2xx body (JSON, else a string) is written to into (a /data path naming an object member) like setData, and {status, headers, durationMs, error?} to into + "__meta" (/data/feed -> /data/feed__meta); a non-2xx status or failure leaves into alone and sets meta.error. statusKey names a declared string state key that moves loading -> success|error, for visibleWhen; onSuccess/onError are action lists (nest up to 4 deep). A newer request to the same into cancels the older. Limits: timeoutMs max 30000 (default 10000), response 262144 bytes, 4 in flight per device. Each finished request is an emit event named prototype_request (payload {requestId, method, url, via, into?, outcome, status?, durationMs, error?}; await it with kind emit, eventName prototype_request). Input checks, validateOn, enabledWhen, {valid: key|keys} conditions and emit.requireValid require prototype_checks_v1; see the guide for checks and formats. textField options (label, variant, supportingText, keyboardType, secure, multiline, minLines, maxLines, maxLength) require prototype_text_field_options_v1; a device without it refuses the show. textField trailingIcon {icon,label,onTap?}, imeAction (done|next|search|send|go) and onSubmit require prototype_text_field_actions_v1 (not allowed with multiline). textField leadingIcon (icon name) requires prototype_text_field_leading_icon_v1. onLongPress/onDoubleTap on box/row/column/text/image/icon/card require prototype_gestures_v1. On Android, show replaceOthers:false retains other windows up to a limit of 4 (prototype_multi_surface_v1); a fifth is refused listing the shown ids. Read the MCP resource automobile:prototype for the authoring guide (repeat grammar, limits, theme roles); look up icon names with automobile:prototype/icons?query=<word>. Read automobile:prototype/native?id=<id> for the spec, assets and a Compose or SwiftUI host file that embed it in an app. searchBar requires prototype_search_bar_v1 for show and patch. {data, empty} conditions and style shimmer require prototype_loading_states_v1. animate, style scale/rotation, transition slideStart|slideEnd|scale and image zoomable require prototype_motion_v2. chart (line/area/bar/ring over /data arrays) requires prototype_chart_v1; observe reports its summary. A root-level storage {version, keys:["state:<key>","data:<pointer>"]} block (up to 64 unique keys: each state key declared in state, each data pointer a member of /data, no overlapping pointers, at most 262144 stored bytes) makes the device save those values per prototype id after every write (user edit, device data action, request response) and requires prototype_storage_v1. Precedence on the next show of the same id: stored values replace the spec\'s for the listed keys; a changed storage.version discards them all; a stored key no longer listed (or a show without storage) is dropped; a stored value that no longer fits (state type changed, data of another JSON kind, unwritable pointer) is dropped and the spec\'s value stands. A host patch to a stored key wins under the usual baseRevision rules and the device then stores it. inspect reports storage {version, keys:[{key,bytes}], totalBytes, skippedKeys?} per prototype (absent if the device does not report it); {action:"clearStorage",id} wipes an id\'s stored values (result cleared = keys removed) and is refused without prototype_storage_v1; deleteSaved also clears them.',
    prototypeSchema,
    handler,
    {
      defaultEnabled: false,
      outputSchema: prototypeOutputSchema,
      deviceReadOnly: isPrototypeReadAction,
      deviceReadOnlyArgs: [{ argument: "action", values: PROTOTYPE_READ_ACTIONS }],
    },
  );
  const dispose = prototypeRegistrationDisposer(host);
  activeRegistration = { host, dispose };
  return dispose;
}
