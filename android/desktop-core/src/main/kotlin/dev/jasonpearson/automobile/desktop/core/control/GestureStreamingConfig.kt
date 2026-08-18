package dev.jasonpearson.automobile.desktop.core.control

/**
 * Feature flag for streaming (real-time) drag input (issue: streaming gesture input).
 *
 * Off by default so the shipped behavior — one atomic `input/swipe` dispatched on release — is
 * unchanged. Enable the experiment by launching the desktop app with
 * `-Dautomobile.gesture.streaming=true`; both control paths ([VideoInputDispatcher] for the video
 * pane and [DeviceControlSession] for the layout-inspector pane) read this once at construction
 * and, when on, stream a drag live with an automatic atomic-swipe fallback for daemons/runners that
 * do not advertise `input/gestureStream`.
 *
 * A plain system-property gate rather than the daemon feature-flag store: this toggles a desktop
 * client behavior, needs no device round-trip, and is read at pane construction — an experiment
 * switch, not a per-device runtime flag.
 */
object GestureStreamingConfig {
  const val SYSTEM_PROPERTY: String = "automobile.gesture.streaming"

  val enabled: Boolean
    get() = System.getProperty(SYSTEM_PROPERTY)?.toBooleanStrictOrNull() == true
}
