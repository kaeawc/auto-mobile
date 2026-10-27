export const PROTOTYPE_TIMERS_CAPABILITY = "prototype_timers_v1";
/** Android control-proxy capability negotiation and request/response registries. */
import type { CtrlProxyRequestType } from "./requestMessages";
import { PROTOTYPE_SAVED_CAPABILITY } from "./prototypeMessages";

/**
 * Legacy optional Android capabilities advertised by WebSocketServer.supportedCommands() in
 * android/control-proxy/src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/WebSocketServer.kt.
 * Services advertising full_command_set_v1 derive all request types from WebSocketRequest's
 * sealed serializer; this subset is used only for older APKs without that marker.
 * Before #8408, AndroidCtrlProxyClient.supportsNodeActionSelectors,
 * supportsAccessibilityLinkActivation, and refreshObservationStreamHierarchyCadence
 * gated node_selector_actions, request_activate_accessibility_link, and
 * set_hierarchy_interval. SendKeys.ts and interactionTools.ts consult
 * the raw advertised list for the remaining optional text/keyboard capabilities.
 */
export const ANDROID_CAPABILITY_REQUEST_TYPES = [
  "show_prototype",
  "dismiss_prototype",
  "put_prototype_asset",
  "remove_prototype_asset",
  "discover_keystore",
  "get_sdk_capabilities",
  "set_hierarchy_interval",
  "request_activate_accessibility_link",
  "request_insert_text_state",
  "request_insert_text",
  "request_commit_text",
  "request_cancel_ime_commit",
  "request_set_keyboard_profile",
  "request_list_keyboard_profiles",
] as const satisfies readonly CtrlProxyRequestType[];

/**
 * Advertised only by a CtrlProxy that attaches `show_prototype` to the requested `displayId`. An
 * older device would ignore the unknown field and show the prototype on the default display. v2: v1 APKs lack the API 32 floor.
 */
export const PROTOTYPE_DISPLAY_CAPABILITY = "prototype_display_id_v2";

/**
 * Advertised only by a CtrlProxy that honours spec `window.layer` and `window.persistence`. An older
 * device decodes the spec leniently and would silently show a session-scoped system-layer prototype.
 */
export const PROTOTYPE_WINDOW_OPTIONS_CAPABILITY = "prototype_window_options_v1";

/**
 * Advertised by a CtrlProxy or iOS prototype agent that honours spec `window.chrome`, draws a
 * fullscreen prototype without the host dismiss bar by default and offers a two-finger long-press
 * escape. A device without it always draws the dismiss bar on a fullscreen prototype.
 */
export const PROTOTYPE_WINDOW_CHROME_CAPABILITY = "prototype_window_chrome_v1";

/**
 * Advertised by a CtrlProxy or iOS prototype agent that honours spec `window.deadTaps` and reports
 * a tap landing on no tappable or input node as an `emit` event named `prototype_dead_tap`
 * (payload `{stack, screen, x, y}`, dp or points). A device without it would ignore the field.
 */
export const PROTOTYPE_DEAD_TAP_CAPABILITY = "prototype_dead_tap_v1";

/** Buffers a device-persistent prototype's events while no host is connected; answers inspect. */
export const PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY = "prototype_persistence_replay_v1";

/**
 * Advertised by a CtrlProxy whose `show_prototype` replaces a prototype of the same id in place,
 * keeping its display and each pager's page unless `reset` is set (#10550). An older device ignores
 * `reset` and re-shows the prototype fresh, so pages restart (#10642).
 */
export const PROTOTYPE_SHOW_IN_PLACE_CAPABILITY = "prototype_show_in_place_v1";

export const PROTOTYPE_MULTI_SURFACE_CAPABILITY = "prototype_multi_surface_v1";

/**
 * Advertised by a CtrlProxy whose prototype renderer lays an anchored node out at its screen-space dp
 * bounds, relative to its own window's origin (#9316). An older device decodes anchors and ignores
 * them, so the node would silently render at its normal position.
 */
export const PROTOTYPE_ANCHOR_CAPABILITY = "prototype_anchor_v1";

/** Renders text field options; an older device decodes and ignores or misdraws the options. */
export const PROTOTYPE_TEXT_FIELD_OPTIONS_CAPABILITY = "prototype_text_field_options_v1";

/** In-window menu and select nodes. */
export const PROTOTYPE_MENUS_CAPABILITY = "prototype_menus_v1";

/** Resolves read-only prototype data, JSON Pointer bindings and stable repeat keys. */
export const PROTOTYPE_EMIT_CONTEXT_CAPABILITY = "prototype_emit_context_v1";
export const PROTOTYPE_CHECKS_CAPABILITY = "prototype_checks_v1";
export const PROTOTYPE_DATA_MODEL_CAPABILITY = "prototype_data_model_v1";
/** setData/appendData/prependData/removeData on `/data`, each write reported as a `change` event. */
export const PROTOTYPE_DATA_ACTIONS_CAPABILITY = "prototype_data_actions_v1";
/** The `request` action (#12523); see prototypeRequest.ts. A `via: "device"` one also needs the second. */
export const PROTOTYPE_NETWORK_CAPABILITY = "prototype_network_v1";
export const PROTOTYPE_NETWORK_DEVICE_CAPABILITY = "prototype_network_device_v1";
/**
 * The platform vocabulary (#14294): root `requires`, `platform.on` handlers, the `platform` action
 * and `{platform}` reads. Each module adds its own `prototype_platform_<module>_v1`, generated from
 * the contract's `platformModules` table; see prototypePlatform.ts.
 */
export const PROTOTYPE_PLATFORM_CAPABILITY = "prototype_platform_v1";
/** Editable in-tree search field with active results and submit/trailing actions. */
export const PROTOTYPE_SEARCH_BAR_CAPABILITY = "prototype_search_bar_v1";
/** `{data, empty}` conditions and style `shimmer` (#14207). */
export const PROTOTYPE_LOADING_STATES_CAPABILITY = "prototype_loading_states_v1";
/** State-key string comparisons and textField forced error presentation. */
export const PROTOTYPE_STRING_CONDITIONS_CAPABILITY = "prototype_string_conditions_v1";
/** Node `animate`, style `scale`/`rotation`, horizontal and scale transitions, zoomable images (#14208). */
export const PROTOTYPE_MOTION_V2_CAPABILITY = "prototype_motion_v2";
/** Transition `delayMs`, container `stagger` and the `blurReplace` transition (#15247). */
export const PROTOTYPE_CHOREOGRAPHY_CAPABILITY = "prototype_choreography_v1";
/** Draws `style.effects`: closed, paint-only looks such as noise, glow and blur (#15128). */
export const PROTOTYPE_EFFECTS_CAPABILITY = "prototype_effects_v1";
/** Lazy list nodes and request.append; advertised together with the data model capability. */
export const PROTOTYPE_LAZY_LIST_CAPABILITY = "prototype_lazy_list_v1";
/** The `chart` node (#14209): line, area, bar and ring charts over `/data` arrays. */
export const PROTOTYPE_CHART_CAPABILITY = "prototype_chart_v1";
/** Chat-list scroll options and the `scrollTo` action (#14232); see prototypeChatScroll.ts. */
export const PROTOTYPE_CHAT_SCROLL_CAPABILITY = "prototype_chat_scroll_v1";

/** Runs long-press and double-tap action lists on generic prototype gesture nodes. */
export const PROTOTYPE_SCROLL_MOTION_CAPABILITY = "prototype_scroll_motion_v1";
export const PROTOTYPE_GESTURES_CAPABILITY = "prototype_gestures_v1";

/** Draws `swipeActions` on a row or listItem and exposes them as accessibility actions. */
export const PROTOTYPE_SWIPE_ACTIONS_CAPABILITY = "prototype_swipe_actions_v1";

/** Draws the textField `trailingIcon` (with its tap actions) and runs `imeAction` with `onSubmit`. */
export const PROTOTYPE_TEXT_FIELD_ACTIONS_CAPABILITY = "prototype_text_field_actions_v1";

/** Draws the `carousel` node and the pager `indicator` option. */
export const PROTOTYPE_CAROUSEL_CAPABILITY = "prototype_carousel_v1";

/** Draws the textField `leadingIcon` in the field's leading slot. */
export const PROTOTYPE_TEXT_FIELD_LEADING_ICON_CAPABILITY = "prototype_text_field_leading_icon_v1";

/** Draws pull-to-refresh on a vertical prototype `scroll` bound to a boolean state key. */
export const PROTOTYPE_REFRESH_CAPABILITY = "prototype_refresh_v1";

/** Screen stacks and push/pop/popToRoot/replace actions with screen_changed snapshots. */
export const PROTOTYPE_STACK_TRANSITIONS_CAPABILITY = "prototype_stack_transitions_v1";
export const PROTOTYPE_STACK_CAPABILITY = "prototype_stack_v1";

/**
 * Advertised by a CtrlProxy or iOS prototype agent whose renderer resolves the per-mode spec forms
 * (#11218): `{light, dark}` colour pairs, role names in gradient stops and scrims,
 * `theme.colors.light` / `theme.colors.dark`, and `{light, dark}` image assets. A device without it
 * rejects or misdraws those forms, so the host refuses the show before sending.
 */
export const PROTOTYPE_FLOW_GRID_CAPABILITY = "prototype_flow_grid_v1";
export const PROTOTYPE_THEME_MODES_CAPABILITY = "prototype_theme_modes_v1";

/** Renders styled text spans and their independent tap actions. */
export const PROTOTYPE_RICH_TEXT_CAPABILITY = "prototype_rich_text_v1";
/** `linkify` on a text node (#14233): mentions, hashtags and URLs as tappable links. */
export const PROTOTYPE_LINKIFY_CAPABILITY = "prototype_linkify_v1";

/** Future iOS capabilities that lift host-reported prototype platform differences. */
export const PROTOTYPE_IDENTIFIER_TEST_TAG_ONLY_CAPABILITY =
  "prototype_identifier_test_tag_only_v1";
export const PROTOTYPE_TEXT_FIELD_MATERIAL_STYLE_CAPABILITY =
  "prototype_text_field_material_style_v1";
export const PROTOTYPE_BOTTOM_SHEET_DRAG_CAPABILITY = "prototype_bottom_sheet_drag_v1";
export const PROTOTYPE_ICON_SET_MATERIAL_CAPABILITY = "prototype_icon_set_material_v1";
/** iOS draws the canonical SF Symbols table and available filled/outlined icon forms. */
export const PROTOTYPE_ICON_SF_SYMBOLS_CAPABILITY = "prototype_icon_sf_symbols_v1";
export const PROTOTYPE_ICON_VARIANT_CAPABILITY = "prototype_icon_variant_v1";

/**
 * Advertised by a CtrlProxy or iOS prototype agent that honours `show_prototype`'s `appearance`,
 * reports the resolved `appearance` in the show result and in inspect or status, re-themes a shown
 * prototype when its resolved mode changes and says so with an `appearance_changed` event (#11215).
 * An older device ignores the request field and follows the device silently, so the host refuses a
 * `light` or `dark` override for one and never sends the field.
 */
export const PROTOTYPE_APPEARANCE_CAPABILITY = "prototype_appearance_v1";

/**
 * Advertised by a CtrlProxy that answers `set_network_mock_rules` (when it carries a requestId)
 * with `set_network_mock_rules_result` naming the rules the app's regex engine rejected (#10101).
 * The host only waits for that reply when the flag is present.
 */
export const NETWORK_MOCK_RULES_REPORT_CAPABILITY = "network_mock_rules_report_v1";

/**
 * Advertised by a CtrlProxy whose window entries for its own prototype carry
 * `prototypePlacement` and `prototypeOpaque`. Older APKs never send them, so consumers fall back to
 * window bounds when the fields are absent.
 */
export const PROTOTYPE_WINDOW_METADATA_CAPABILITY = "prototype_window_metadata_v1";

/**
 * Advertised by a CtrlProxy whose `get_sdk_capabilities` honours `userId` (work or secondary
 * profile). An older service ignores the unknown field and reads its own user's app instance, so the
 * host omits it there.
 */
export const SDK_CAPABILITIES_USER_ID_CAPABILITY = "sdk_capabilities_user_id_v1";

/**
 * Advertised by a device agent whose `request_screenshot` honours `hidePrototypes` (#9305): it hides
 * its own prototype window, waits for a rendered frame, captures and restores, all in that one
 * request, and answers with `prototypesHidden`. The iOS prototype agent advertises the same string for
 * its `hide_for_capture` handshake. An older agent ignores the field and captures with the prototype
 * showing.
 */
export const SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY = "screenshot_hide_prototype_v1";

/**
 * request_two_finger_swipe honours fingerCount (2-5). An older service ignores the field and would
 * silently perform two fingers, so hosts refuse a larger count before dispatch.
 */
export const MULTI_FINGER_GESTURE_CAPABILITY = "multi_finger_gesture_v1";

/**
 * request_action honours the semantic accessibility actions (expand, collapse, dismiss, select,
 * scroll and page directions, press_and_hold, set_progress with `progress`, custom with
 * `customAction`) and its refusal lists the node's available actions (#14077). An older service
 * refuses them as unsupported, so hosts require this flag before sending one.
 */
export const SEMANTIC_NODE_ACTIONS_CAPABILITY = "semantic_node_actions_v1";

/**
 * `request_global_action` accepts the system actions behind `pressButton` (#14095). A CtrlProxy
 * advertises each flag only when it knows the action and the device API level can perform it, so
 * one check covers both the APK and the Android version. An older APK drops the unknown action.
 */
export const GLOBAL_ACTION_POWER_DIALOG_CAPABILITY = "global_action_power_dialog_v1";
export const GLOBAL_ACTION_QUICK_SETTINGS_CAPABILITY = "global_action_quick_settings_v1";
export const GLOBAL_ACTION_SPLIT_SCREEN_CAPABILITY = "global_action_split_screen_v1";
export const GLOBAL_ACTION_LOCK_SCREEN_CAPABILITY = "global_action_lock_screen_v1";
export const GLOBAL_ACTION_SCREENSHOT_CAPABILITY = "global_action_screenshot_v1";
export const GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE_CAPABILITY =
  "global_action_dismiss_notification_shade_v1";

/** Capability flags in the handshake that are never sent as wire requests. */
export const ANDROID_CAPABILITY_FLAGS = [
  "node_selector_actions",
  SEMANTIC_NODE_ACTIONS_CAPABILITY,
  GLOBAL_ACTION_POWER_DIALOG_CAPABILITY,
  GLOBAL_ACTION_QUICK_SETTINGS_CAPABILITY,
  GLOBAL_ACTION_SPLIT_SCREEN_CAPABILITY,
  GLOBAL_ACTION_LOCK_SCREEN_CAPABILITY,
  GLOBAL_ACTION_SCREENSHOT_CAPABILITY,
  GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE_CAPABILITY,
  "ime_key_events_v1",
  "ime_clear_field_v1",
  "ime_password_commit_v1",
  "ime_inserted_text_v1",
  "ime_commit_trace_v1",
  "gesture_display_id_v1",
  "tap_double_v1",
  MULTI_FINGER_GESTURE_CAPABILITY,
  PROTOTYPE_SAVED_CAPABILITY,
  PROTOTYPE_DISPLAY_CAPABILITY,
  PROTOTYPE_WINDOW_OPTIONS_CAPABILITY,
  PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY,
  PROTOTYPE_SHOW_IN_PLACE_CAPABILITY,
  PROTOTYPE_STACK_CAPABILITY,
  PROTOTYPE_MULTI_SURFACE_CAPABILITY,
  PROTOTYPE_ANCHOR_CAPABILITY,
  NETWORK_MOCK_RULES_REPORT_CAPABILITY,
  PROTOTYPE_WINDOW_METADATA_CAPABILITY,
  SDK_CAPABILITIES_USER_ID_CAPABILITY,
  SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY,
] as const;

/** The supportedCommands list is authoritative for every request when this marker is present. */
export const ANDROID_FULL_COMMAND_SET_CAPABILITY = "full_command_set_v1";

/** Requests carrying requestId receive responses echoing that ID, including hierarchy replies. */
export const ANDROID_REQUEST_ID_ECHO_CAPABILITY = "request_id_echo_v1";

/** Result handlers that settle RequestManager waiters and therefore require an echoed ID. */
export const ANDROID_REQUEST_ID_RESPONSE_TYPES: ReadonlySet<string> = new Set([
  "screenshot",
  "screenshot_error",
  "swipe_result",
  "tap_coordinates_result",
  "drag_result",
  "pinch_result",
  "set_text_result",
  "commit_text_result",
  "cancel_ime_commit_result",
  "set_keyboard_profile_result",
  "set_network_mock_rules_result",
  "keyboard_profiles_result",
  "insert_text_state_result",
  "insert_text_result",
  "ime_action_result",
  "select_all_result",
  "action_result",
  "clipboard_result",
  "settings_get_result",
  "settings_put_result",
  "settings_list_result",
  "installed_packages_result",
  "package_info_result",
  "launch_intent_result",
  "ca_cert_result",
  "device_owner_status_result",
  "permission_result",
  "current_focus_result",
  "traversal_order_result",
  "highlight_response",
  "prototype_result",
  "global_action_result",
  "frame_context_validation_result",
  "device_info_result",
  "keystore_discovery",
  "sdk_capabilities",
  "preference_files",
  "preferences",
  "subscribe_storage_result",
  "unsubscribe_storage_result",
  "get_preference_result",
  "set_preference_result",
  "remove_preference_result",
  "clear_preferences_result",
]);

/** Push/handshake handlers; hierarchy pushes and uncorrelatable protocol errors may omit IDs. */
export const ANDROID_ID_LESS_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "connected",
  "error",
  "hierarchy_update",
  "display_transition",
  "navigation_event",
  "package_event",
  "interaction_event",
  "prototype_event",
  "handled_exception_event",
  "crash_event",
  "anr_event",
  "frame_metrics_event",
  "storage_changed",
  "network_event",
  "websocket_frame_event",
  "log_event",
  "broadcast_event",
  "lifecycle_event",
]);

export type CtrlProxyMissingRequestIdError =
  `Android service advertised request_id_echo_v1 but sent ${string} without a requestId`;

/** Stable protocol diagnostic; an id-less result cannot safely be assigned to any waiter. */
export function ctrlProxyMissingRequestIdError(type: string): CtrlProxyMissingRequestIdError {
  return `Android service advertised request_id_echo_v1 but sent ${type} without a requestId`;
}

export const ANDROID_CAPABILITY_GATED_COMMANDS: ReadonlySet<string> = new Set([
  ...ANDROID_CAPABILITY_REQUEST_TYPES,
  ...ANDROID_CAPABILITY_FLAGS,
]);

/**
 * Every request discriminator, exhaustively checked against the TS union.
 * AndroidWireContract.contract.test.ts compares these keys and the field manifests with the
 * descriptor-generated android-wire-contract.json; Kotlin verifies fixture freshness.
 */
const REQUEST_TYPE_REGISTRY: Record<CtrlProxyRequestType, true> = {
  request_hierarchy: true,
  request_hierarchy_if_stale: true,
  set_hierarchy_interval: true,
  request_screenshot: true,
  request_tap_coordinates: true,
  request_swipe: true,
  request_two_finger_swipe: true,
  request_drag: true,
  request_pinch: true,
  request_gesture_start: true,
  request_gesture_move: true,
  request_gesture_end: true,
  request_set_text: true,
  request_insert_text_state: true,
  request_insert_text: true,
  request_commit_text: true,
  request_cancel_ime_commit: true,
  request_set_keyboard_profile: true,
  request_list_keyboard_profiles: true,
  request_ime_action: true,
  request_select_all: true,
  request_action: true,
  request_click_focused_input: true,
  request_activate_accessibility_link: true,
  request_hit_test: true,
  request_clipboard: true,
  request_settings_get: true,
  request_settings_put: true,
  request_settings_list: true,
  install_ca_cert: true,
  install_ca_cert_from_path: true,
  remove_ca_cert: true,
  get_device_owner_status: true,
  get_permission: true,
  request_device_info: true,
  get_current_focus: true,
  get_traversal_order: true,
  add_highlight: true,
  show_prototype: true,
  dismiss_prototype: true,
  inspect_prototypes: true,
  patch_prototype: true,
  save_prototype: true,
  pin_saved_prototype: true,
  list_saved_prototypes: true,
  delete_saved_prototype: true,
  advance_prototype_clock: true,
  clear_prototype_storage: true,
  put_prototype_asset: true,
  remove_prototype_asset: true,
  list_preference_files: true,
  get_preferences: true,
  discover_keystore: true,
  get_sdk_capabilities: true,
  list_data_stores: true,
  get_data_store: true,
  subscribe_storage: true,
  unsubscribe_storage: true,
  get_preference: true,
  set_preference: true,
  remove_preference: true,
  clear_preferences: true,
  request_global_action: true,
  validate_frame_context: true,
  set_recomposition_tracking: true,
  set_accessibility_flags: true,
  set_network_mock_rules: true,
  set_network_error_simulation: true,
  request_installed_packages: true,
  request_package_info: true,
  request_launch_intent: true,
  start_recording: true,
  stop_recording: true,
};

/** All request `type` discriminators known to this contract (mirrors `WebSocketRequest.kt`). */
export const KNOWN_REQUEST_TYPES: readonly CtrlProxyRequestType[] = Object.keys(
  REQUEST_TYPE_REGISTRY,
) as CtrlProxyRequestType[];

export const PROTOTYPE_PAGER_STATE_KEY_CAPABILITY = "prototype_pager_state_key_v1";

export const PROTOTYPE_PAGER_OPTIONS_CAPABILITY = "prototype_pager_options_v1";

export const PROTOTYPE_STYLE_POLISH_V2_CAPABILITY = "prototype_style_polish_v2";

export const PROTOTYPE_TOOLTIP_CAPABILITY = "prototype_tooltip_v1";

export const PROTOTYPE_DRAWER_CAPABILITY = "prototype_drawer_v1";

export const PROTOTYPE_STRINGS_CAPABILITY = "prototype_strings_v1";

export const PROTOTYPE_SEMANTICS_CAPABILITY = "prototype_semantics_v1";

export const PROTOTYPE_FORMAT_CAPABILITY = "prototype_format_v1";
