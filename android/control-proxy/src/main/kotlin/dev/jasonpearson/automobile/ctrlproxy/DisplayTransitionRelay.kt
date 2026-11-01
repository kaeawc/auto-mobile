package dev.jasonpearson.automobile.ctrlproxy

/**
 * Relays a display transition off the display callback thread: to the prototype controller, so a
 * surface on a removed display drops its window, then to connected clients as a frame.
 */
internal class DisplayTransitionRelay(private val host: Host) {
  /** The service pieces a transition reaches; either may not exist yet during startup. */
  interface Host {
    fun launch(block: suspend () -> Unit)

    fun isPrototypeReady(): Boolean

    suspend fun prototypeDisplayTransition(displayId: Int, removed: Boolean)

    fun isServerRunning(): Boolean

    suspend fun broadcast(frame: String)
  }

  fun onTransition(transition: DisplayTransition) {
    host.launch {
      if (host.isPrototypeReady()) {
        host.prototypeDisplayTransition(
          transition.displayId,
          removed = transition.change == "removed",
        )
      }
      if (host.isServerRunning()) {
        host.broadcast(displayTransitionFrame(transition))
      }
    }
  }
}
