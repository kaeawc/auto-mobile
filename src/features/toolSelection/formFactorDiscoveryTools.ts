/**
 * Tools a session lists by default because of the device it acquired (#18029). Most tools are off
 * by default to keep `tools/list` small on every device, and stay so. On a TV the D-pad is the
 * only input, so a tool registered `defaultEnabledOnTv` (`focusNavigate`, the TV navigation tool)
 * is listed for a TV session the way `tapOn` is listed for a phone; without it an agent working
 * from `tools/list` never finds it.
 */

import type { SessionToolSelectionService } from "./SessionToolSelectionService";

/** What an acquisition result says about its device. */
export interface AcquiredDeviceKind {
  platform: string | undefined;
  formFactor: string | undefined;
}

/** Whether the acquired device is a TV: an Android TV form factor or an Apple TV. */
export function isTvDevice(device: AcquiredDeviceKind): boolean {
  return device.formFactor === "tv" || device.platform === "tvos";
}

/**
 * Whether nothing has chosen this tool's state for the session: neither a startup default
 * (`--enable-tool`/`--disable-tool`, environment) nor a session choice. Read as the one case where
 * the result follows the declared default, so an explicit choice always wins.
 */
async function isUnchosen(
  selection: Pick<SessionToolSelectionService, "isEnabled">,
  sessionUuid: string,
  toolName: string,
): Promise<boolean> {
  const [whenOff, whenOn] = await Promise.all([
    selection.isEnabled(sessionUuid, toolName, false),
    selection.isEnabled(sessionUuid, toolName, true),
  ]);
  return !whenOff && whenOn;
}

/**
 * The form-factor tools to enable for a freshly acquired session: `tvTools` on a TV, minus any
 * the operator or the session already chose a state for. Empty for any other device.
 */
export async function formFactorDiscoveryTools(
  selection: Pick<SessionToolSelectionService, "isEnabled">,
  sessionUuid: string,
  { device, tvTools }: { device: AcquiredDeviceKind; tvTools: readonly string[] },
): Promise<string[]> {
  if (!isTvDevice(device)) {
    return [];
  }
  const unchosen = await Promise.all(
    tvTools.map((name) => isUnchosen(selection, sessionUuid, name)),
  );
  return tvTools.filter((_, index) => unchosen[index]);
}
