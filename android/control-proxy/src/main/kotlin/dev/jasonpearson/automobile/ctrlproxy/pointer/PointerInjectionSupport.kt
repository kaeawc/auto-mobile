package dev.jasonpearson.automobile.ctrlproxy.pointer

/**
 * When CtrlProxy advertises `stylus_input_v1` and `hover_input_v1`.
 *
 * `am instrument` force-stops its target package when it starts and again when it finishes unless
 * it is given `--no-restart`. The instrumentation targets CtrlProxy's own package, so without that
 * flag every injection would kill the accessibility service and its WebSocket server. The flag
 * arrived with the Android 13 `am` (API 33); the host always passes it, and older devices do not
 * advertise the route, so a hover is refused there instead of dropping the connection.
 * Device-unverified: the probe plan in the design note confirms both the API level and that the
 * connection survives.
 */
internal object PointerInjectionSupport {
  const val MIN_SDK = 33

  fun advertised(sdkInt: Int): Boolean = sdkInt >= MIN_SDK
}
