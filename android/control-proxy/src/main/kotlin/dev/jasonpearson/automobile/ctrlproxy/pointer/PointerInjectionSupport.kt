package dev.jasonpearson.automobile.ctrlproxy.pointer

/**
 * When CtrlProxy advertises `stylus_input_v1` and `hover_input_v1`.
 *
 * `am instrument` force-stops its target package when it starts and again when it finishes unless
 * it is given `--no-restart`. The instrumentation targets CtrlProxy's own package, so without that
 * flag every injection would kill the accessibility service and its WebSocket server. Measured on
 * emulators (#13082): API 30's `am` rejects the flag, while API 31, 32, 33 and 37 accept it,
 * inject, and keep the service bound. The host always passes it, and older devices do not advertise
 * the route, so a hover is refused there instead of dropping the connection.
 */
internal object PointerInjectionSupport {
  const val MIN_SDK = 31

  fun advertised(sdkInt: Int): Boolean = sdkInt >= MIN_SDK
}
