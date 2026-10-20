/**
 * ctrlProxyProtocol - Typed request contract for the Android control-proxy WebSocket client.
 *
 * This module is the TypeScript mirror of the authoritative Kotlin wire contract in
 * `android/protocol/src/main/kotlin/dev/jasonpearson/automobile/protocol/WebSocketRequest.kt`
 * (issue #2752 / PR #2771). Every interface here corresponds to a `@SerialName`'d data class
 * on the device. AndroidWireContract.contract.test.ts checks field names and requiredness against
 * the descriptor-generated test/fixtures/android-contract/android-wire-contract.json so the JSON
 * on the wire matches the device contract. Millisecond durations are rounded for its Long fields.
 *
 * Sends are constructed via the {@link ctrlProxyRequests} builders — each returns a typed
 * {@link CtrlProxyRequest} — and serialized through {@link serializeCtrlProxyRequest}. When a send
 * is built this way, a misspelled `type` or a malformed field set is a compile error rather than a
 * runtime failure on-device. This is a module-level convention, not a transport-level lock: the
 * underlying `ws.send(string)` still accepts any string, so a raw `JSON.stringify` could bypass the
 * layer. Enforcing it with a typed `sendRequest(request: CtrlProxyRequest)` transport chokepoint is
 * a possible follow-up (it would need to unify the delegates' differing not-connected semantics).
 *
 * SCOPE — Android control-proxy only.
 * - The gesture/text commands (`request_tap_coordinates`, `request_swipe`, `request_two_finger_swipe`,
 *   `request_drag`, `request_pinch`, `request_set_text`, `request_ime_action`, `request_select_all`)
 *   are emitted through the cross-platform shared `sendCommand()` / `createMessage()` path in
 *   `src/features/observe/DeviceServiceUtils.ts`. They are typed here for contract completeness
 *   (drift cross-check). CtrlProxyGestures normalizes Android millisecond parameters through
 *   this module before that shared path serializes them. They are not re-routed through Android's
 *   typed serializer, keeping the shared iOS client independent of the Android contract.
 * - `request_hit_test` is device-supported but has no TS sender yet; typed here to keep the union
 *   equal to the device `@SerialName` set (the drift guard depends on that equality).
 * - The iOS client (`src/features/observe/ios/`) has its own hand-built sends that could get the
 *   same treatment separately.
 */

export {
  PROTOTYPE_STORAGE_CAPABILITY,
  type ClearPrototypeStorageMessage,
  type PrototypeStorageReport,
} from "../../prototype/prototypeStorageWire";
export * from "./ctrlProxyProtocol/requestMessages";
export * from "./ctrlProxyProtocol/prototypeMessages";
export * from "./ctrlProxyProtocol/capabilities";
export * from "./ctrlProxyProtocol/requestBuilders";
