/**
 * Checked-in copy of the iOS CtrlProxy runner's inbound command contract.
 *
 * The Swift runner locks its own inbound set with `RequestType` (a
 * `String, CaseIterable` enum in `ios/control-proxy/Sources/CtrlProxy/Models.swift`)
 * and `TypedRequestDecodeTests.testEveryRequestTypeDecodesToMatchingCase` fails a
 * test if an enum case is dropped or renamed. But nothing asserted that the set of
 * command `type` strings the **TS client emits** stays a subset of those rawValues,
 * so a new/renamed TS command compiled cleanly and only failed at runtime on-device
 * with an "Unknown command type: <type>" error (issue #2857).
 *
 * This list is the authoritative device contract the TS iOS client mirrors — the
 * iOS analog of Android's `KNOWN_REQUEST_TYPES` (#2835). It is transcribed by hand
 * from the Swift `RequestType` enum; `ctrlProxyWireParity.integration.test.ts` reads the actual
 * rawValues out of `Models.swift` and fails if this list drifts from them, and also
 * fails if any command string the iOS client can emit is not a member of this set.
 *
 * Keep this in lockstep with the Swift `RequestType` enum. Adding a TS command
 * without a matching rawValue here (and in Swift) is a test failure by design.
 */
export const IOS_KNOWN_REQUEST_TYPES = [
  // View hierarchy
  "request_hierarchy",
  "request_hierarchy_if_stale",
  "set_hierarchy_poll_interval",
  "request_screenshot",

  // Gestures
  "request_tap_coordinates",
  "request_swipe",
  "request_two_finger_swipe",
  "request_multi_finger_swipe",
  "request_drag",
  "request_pinch",

  // Text input
  "request_set_text",
  "request_append_text",
  "request_clear_text",
  "request_ime_action",
  "request_select_all",
  "request_keyboard",
  "request_press_key",
  "request_press_button",
  "request_press_home",
  "request_press_back",
  "request_shake",
  "request_recent_apps",

  // Node actions
  "request_action",
  "request_activate_accessibility_link",
  "request_launch_app",

  // App privacy permissions
  "request_reset_permissions",

  // Device control
  "request_rotate",

  // Clipboard
  "request_clipboard",

  // Accessibility features
  "get_current_focus",
  "get_traversal_order",
  "add_highlight",
  "get_voiceover_state",
  "set_voiceover_state",

  // Storage inspection
  "list_preference_files",
  "get_preferences",
  "get_preference",
  "set_preference",
  "remove_preference",
  "clear_preferences",

  // Network mocking
  "set_network_mock_rules",
  "set_network_fault_rules",
  "set_network_error_simulation",

  // Database inspection
  "execute_sql",
  "list_databases",
  "storage_capabilities",
  "list_tables",
  "get_table_data",
  "get_table_structure",
] as const;

/** Set form for O(1) membership checks in the wire-parity guard. */
export const IOS_KNOWN_REQUEST_TYPE_SET: ReadonlySet<string> = new Set(IOS_KNOWN_REQUEST_TYPES);
