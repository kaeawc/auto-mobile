package dev.jasonpearson.automobile.ctrlproxy

/** Owns the listener across accessibility service unbind and same-process reconnect. */
internal class ServerLifecycle<T>(private val stopServer: (T) -> Unit) {
  private var current: T? = null

  fun replace(server: T) {
    stop()
    current = server
  }

  fun stop() {
    val previous = current ?: return
    current = null
    stopServer(previous)
  }
}
