import "./deviceLifecycleHost";
import { startDeviceOutputSchema } from "./toolOutputSchemas";
import { ToolRegistry } from "./toolRegistry";
import { registerDeviceResourceTools } from "./deviceResourceTools";
import { acquireUndoneIfUndelivered } from "../daemon/acquisitionUndo";
import { createProvisionDeviceHandlers } from "./deviceToolsProvisioning";
import { createAcquisitionHandlers } from "./deviceToolsAcquisition";
import {
  bindBootedDeviceSession,
  createBootAndPrepareDevice,
  createStartDeviceHandlers,
  ensureCtrlProxyReady,
} from "./deviceToolsStartDevice";
import { createLifecycleHandlers } from "./deviceToolsLifecycle";
import { createListingHandlers } from "./deviceToolsListing";
import {
  getAndroidSchema,
  getAppleSchema,
  getDeviceTeardownService,
  getDeviceToolsDependencies,
  provisionDeviceSchema,
  startDeviceSchema,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { registerDaemonDeviceDeletion } from "../daemon/daemonDeviceDeletion";
import {
  killDeviceSchema,
  listDeviceImagesOutputSchema,
  listDeviceImagesSchema,
  listDevicesOutputSchema,
  listDevicesSchema,
  provisionDeviceOutputSchema,
  teardownDeviceSchema,
} from "../features/deviceLifecycle/core/toolSchemas";
export * from "../features/deviceLifecycle/deviceLifecycleCore";
export {
  killDeviceSchema,
  listDeviceImagesSchema,
  listDevicesOutputSchema,
  listDevicesSchema,
  teardownDeviceSchema,
};

export { reserveAndroidStartupLease } from "./deviceToolsStartupLease";

export function registerDeviceTools() {
  const { listDeviceImagesHandler, listDevicesHandler } = createListingHandlers();

  const { killDeviceHandler, executeDeleteDevice, deleteDeviceHandler } = createLifecycleHandlers();
  // The daemon's own deletions (abandoned broker bindings, #11174) run the same verified workflow with
  // no caller: the broker binding and session-holder refusals guard callers, not the daemon itself.
  registerDaemonDeviceDeletion((args, signal) => {
    const deps = getDeviceToolsDependencies();
    return executeDeleteDevice(args, deps, signal, getDeviceTeardownService(deps));
  });

  const provisionHandlers = createProvisionDeviceHandlers({
    bindBootedDeviceSession,
    ensureCtrlProxyReady,
    executeDeleteDevice,
  });
  // createIfMissing rolls back through provisionDevice's cleanup (#11100).
  const acquisitionHandlers = createAcquisitionHandlers({
    bootAndPrepareDevice: createBootAndPrepareDevice(provisionHandlers.rollbackCreatedDevice),
  });
  const { startDeviceHandler } = createStartDeviceHandlers({
    prepareDevice: acquisitionHandlers.prepareDevice,
    stripInternalAcquisitionParams: acquisitionHandlers.stripInternalAcquisitionParams,
  });
  const { getAndroidHandler, getAppleHandler } = acquisitionHandlers;
  const { provisionDeviceHandler } = provisionHandlers;

  // Register with the tool registry
  registerDeviceResourceTools(getDeviceToolsDependencies);
  ToolRegistry.register(
    "listDeviceImages",
    "List device images",
    listDeviceImagesSchema,
    listDeviceImagesHandler,
    {
      defaultEnabled: true,
      outputSchema: listDeviceImagesOutputSchema,
      readOnly: true,
      hostInventory: true,
    },
  );

  ToolRegistry.register(
    "listDevices",
    "List booted devices; pending configured-image enrichment includes retry hints and failed provenance includes a non-retryable reason; resource pointers for images and detail in the note",
    listDevicesSchema,
    listDevicesHandler,
    {
      defaultEnabled: true,
      outputSchema: listDevicesOutputSchema,
      readOnly: true,
      hostInventory: true,
    },
  );

  // The acquiring tools are registered as the request-level race sees them: a call whose client
  // cancelled before the handler answers is undone and fails with the cancellation (#11593).
  // provisionDevice does the same inside its handler, where its typed cancellation is built.
  ToolRegistry.register(
    "getAndroid",
    "Find or recover an Android AVD and prepare it for automation. See the automobile:tools resource for every tool's default enabled/gated state before acquiring a device.",
    getAndroidSchema,
    (args, progress, signal) =>
      acquireUndoneIfUndelivered(signal, () => getAndroidHandler(args, progress, signal)),
    { defaultEnabled: true, supportsProgress: true, transportRecovery: "connect" },
  );

  ToolRegistry.register(
    "getApple",
    "Find or recover an iOS Simulator and prepare it for automation. See the automobile:tools resource for every tool's default enabled/gated state before acquiring a device.",
    getAppleSchema,
    (args, progress, signal) =>
      acquireUndoneIfUndelivered(signal, () => getAppleHandler(args, progress, signal)),
    { defaultEnabled: true, supportsProgress: true, transportRecovery: "connect" },
  );

  ToolRegistry.register(
    "startDevice",
    "Start device",
    startDeviceSchema,
    (args, progress, signal) =>
      acquireUndoneIfUndelivered(signal, () => startDeviceHandler(args, progress, signal)),
    {
      outputSchema: startDeviceOutputSchema,
      defaultEnabled: true,
      supportsProgress: true,
      hidden: true,
      transportRecovery: "connect",
    },
  );

  ToolRegistry.register(
    "provisionDevice",
    "Provision exact virtual device",
    provisionDeviceSchema,
    provisionDeviceHandler,
    {
      defaultEnabled: false,
      outputSchema: provisionDeviceOutputSchema,
      transportRecovery: "connect",
    },
  );

  ToolRegistry.register("killDevice", "Kill device", killDeviceSchema, killDeviceHandler, {
    defaultEnabled: true,
    transportRecovery: "connect",
  });

  ToolRegistry.register(
    "deleteDevice",
    "Stop and permanently delete a device, with verified platform-inventory absence",
    teardownDeviceSchema,
    deleteDeviceHandler,
    { defaultEnabled: false, transportRecovery: "connect" },
  );
}
