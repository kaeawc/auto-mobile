package dev.jasonpearson.automobile.sdk

/** Receives host-registered lifecycle and context changes. */
fun interface RuntimeContextListener {
  /**
   * Called after a runtime context change or lifecycle event.
   *
   * The snapshot is immutable and represents the state after the event.
   */
  fun onRuntimeContextChanged(
    kind: String,
    snapshot: dev.jasonpearson.automobile.sdk.context.SdkContextSnapshot,
  )
}
