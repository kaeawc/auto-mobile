import { ENV, readEnvBool } from "../../../config/env";
import type { BootedDevice } from "../../../models";

/**
 * Headless prototype mode (#17974): the daemon holds prototypes in memory on a virtual device, so
 * the prototype tool works with no adb, emulator or simulator. Selection is explicit only.
 */
export function isHeadlessPrototypeMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnvBool(ENV.HEADLESS, env);
}

/** `--headless` sets the variable so a daemon this process spawns inherits the mode. */
export function enableHeadlessPrototypeMode(env: NodeJS.ProcessEnv): void {
  env[ENV.HEADLESS.name] = "1";
}

export const VIRTUAL_PROTOTYPE_DEVICE_ID = "automobile-virtual-prototype";

/**
 * The virtual device the prototype tool runs on in headless mode. It speaks the Android
 * prototype protocol, so the shared Android paths (capability gates, inspect, patch) apply.
 */
export const VIRTUAL_PROTOTYPE_DEVICE: Readonly<BootedDevice> = Object.freeze({
  name: "AutoMobile virtual prototype device",
  platform: "android",
  deviceId: VIRTUAL_PROTOTYPE_DEVICE_ID,
});

export function isVirtualPrototypeDevice(device: Pick<BootedDevice, "deviceId">): boolean {
  return device.deviceId === VIRTUAL_PROTOTYPE_DEVICE_ID;
}

/**
 * Spec features the host web renderer draws and the virtual device holds in memory: a show that
 * uses them is accepted exactly as on a CtrlProxy that advertises them.
 */
export const VIRTUAL_PROTOTYPE_CAPABILITIES: readonly string[] = [
  "prototype_patch_v1",
  "prototype_persistence_replay_v1",
  "prototype_show_in_place_v1",
  "prototype_adaptive_v1",
  "prototype_bar_scroll_v1",
  "prototype_chart_v1",
  "prototype_chat_scroll_v1",
  "prototype_checks_v1",
  "prototype_choreography_v1",
  "prototype_content_transition_v1",
  "prototype_data_actions_v1",
  "prototype_data_model_v1",
  "prototype_drawer_v1",
  "prototype_effects_v1",
  "prototype_emit_context_v1",
  "prototype_flow_grid_v1",
  "prototype_format_v1",
  "prototype_icon_effects_v1",
  "prototype_keyframes_v1",
  "prototype_lazy_list_v1",
  "prototype_linkify_v1",
  "prototype_loops_v1",
  "prototype_menus_v1",
  "prototype_motion_tokens_v1",
  "prototype_motion_v2",
  "prototype_motion_v3",
  "prototype_network_v1",
  "prototype_pager_options_v1",
  "prototype_pager_state_key_v1",
  "prototype_reduced_motion_v1",
  "prototype_refresh_v1",
  "prototype_rich_text_v1",
  "prototype_routes_v1",
  "prototype_scroll_motion_v1",
  "prototype_search_bar_v1",
  "prototype_semantics_v1",
  "prototype_shared_element_v1",
  "prototype_shared_element_v2",
  "prototype_stack_transitions_v1",
  "prototype_stack_v1",
  "prototype_string_conditions_v1",
  "prototype_strings_v1",
  "prototype_text_field_leading_icon_v1",
  "prototype_text_field_options_v1",
  "prototype_theme_modes_v1",
  "prototype_tooltip_v1",
  "prototype_window_motion_v1",
];

/**
 * Device features a real device has and the virtual device cannot emulate. A spec or action that
 * needs one is refused by the same gate that refuses an older device; every result names them.
 */
export const VIRTUAL_PROTOTYPE_UNSUPPORTED_CAPABILITIES: readonly string[] = [
  "prototype_anchor_v1",
  "prototype_appearance_v1",
  "prototype_backdrop_v1",
  "prototype_custom_shaders_v1",
  "prototype_dead_tap_v1",
  "prototype_display_id_v1",
  "prototype_display_id_v2",
  "prototype_hide_keyboard_v1",
  "prototype_multi_surface_v1",
  "prototype_network_device_v1",
  "prototype_platform_v1",
  "prototype_platform_window_controls_v1",
  "prototype_saved_v1",
  "prototype_storage_v1",
  "prototype_timers_v1",
  "prototype_window_chrome_v1",
  "prototype_window_options_v1",
];

/** Actions that need a real device's own storage, launcher, display or clock. */
const DEVICE_ONLY_ACTIONS = new Set([
  "save",
  "listSaved",
  "deleteSaved",
  "open",
  "clearStorage",
  "simulate",
]);

/** Why the virtual device refuses a call before anything runs, or undefined when it can run it. */
export function headlessPrototypeRefusal(args: {
  action: string;
  display?: unknown;
}): string | undefined {
  if (DEVICE_ONLY_ACTIONS.has(args.action)) {
    return `${args.action} needs a real device: the headless virtual device has no saved prototypes, storage or prototype clock. Run without AUTOMOBILE_HEADLESS/--headless on an Android device or iOS simulator.`;
  }
  if (args.display !== undefined) {
    return "display needs a real Android device: the headless virtual device has one display. Omit display.";
  }
  return undefined;
}

/** Added to every prototype result produced on the virtual device. */
export interface VirtualPrototypeDeviceReport {
  deviceId: string;
  renderer: "web";
  unsupportedCapabilities: string[];
}

export function virtualPrototypeDeviceReport(): VirtualPrototypeDeviceReport {
  return {
    deviceId: VIRTUAL_PROTOTYPE_DEVICE_ID,
    renderer: "web",
    unsupportedCapabilities: [...VIRTUAL_PROTOTYPE_UNSUPPORTED_CAPABILITIES],
  };
}
