import { ActionableError, type BootedDevice, type ObserveResult } from "../../../models";
import { logger } from "../../../utils/logger";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import { getSystemTrayDependencies } from "./dependencies";
import { ensureSystemTrayOpen, observeSystemTray, sleep } from "./runtime";
import { returnToWatchFace } from "./watchFace";
import { watchAlert } from "./watchHierarchy";

const ALERT_POLL_MS = 250;
const ALERT_DISMISS_SETTLE_MS = 1500;
const ALERT_DISMISS_TIMEOUT_MESSAGE =
  "A notification alert is covering the watch. Dismiss the alert with Back, then retry opening the notification stream.";

function readWatch(device: BootedDevice, signal?: AbortSignal): Promise<ObserveResult> {
  return observeSystemTray(
    getSystemTrayDependencies().observeScreenFactory(device),
    0,
    signal,
    true,
  );
}

async function dismissWatchAlert(
  device: BootedDevice,
  initial: ObserveResult,
  deadline: number,
  signal?: AbortSignal,
): Promise<ObserveResult> {
  const alert = watchAlert(initial.viewHierarchy);
  if (alert?.kind !== "full") {
    return initial;
  }
  throwIfAborted(signal);
  await awaitWhileRequestIsLive(
    getSystemTrayDependencies()
      .adbFactory(device)
      .executeCommand("shell input keyevent 4", { signal }),
    signal,
  );
  let current = await readWatch(device, signal);
  while (watchAlert(current.viewHierarchy)?.kind === "full") {
    const remaining = deadline - getSystemTrayDependencies().timer.now();
    if (remaining <= 0) {
      throw new ActionableError(ALERT_DISMISS_TIMEOUT_MESSAGE);
    }
    await sleep(Math.min(ALERT_POLL_MS, remaining), signal);
    current = await readWatch(device, signal);
  }
  // Alert nodes disappear before the dismiss animation stops intercepting the open swipe.
  const remaining = deadline - getSystemTrayDependencies().timer.now();
  if (remaining > 0) {
    await sleep(Math.min(ALERT_DISMISS_SETTLE_MS, remaining), signal);
  }
  if (getSystemTrayDependencies().timer.now() >= deadline) {
    throw new ActionableError(ALERT_DISMISS_TIMEOUT_MESSAGE);
  }
  current = await readWatch(device, signal);
  logger.info(
    `[systemTray] Notification alert from ${alert.appLabel ?? "an unknown app"} was dismissed`,
  );
  return current;
}

export async function prepareWatchSystemTray(
  device: BootedDevice,
  timeout: number,
  signal?: AbortSignal,
) {
  const deadline = getSystemTrayDependencies().timer.now() + timeout;
  // A covering alert hides whatever is under it, so dismiss it before leaving an app (#17443).
  const dismissed = await dismissWatchAlert(
    device,
    await readWatch(device, signal),
    deadline,
    signal,
  );
  const initial = await returnToWatchFace(device, dismissed, signal);
  return {
    initial,
    remainingTimeout: Math.max(0, deadline - getSystemTrayDependencies().timer.now()),
  };
}

export async function openWatchSystemTray(
  device: BootedDevice,
  timeout: number,
  signal?: AbortSignal,
) {
  const { initial, remainingTimeout } = await prepareWatchSystemTray(device, timeout, signal);
  return ensureSystemTrayOpen(device, remainingTimeout, { signal, initialObservation: initial });
}
