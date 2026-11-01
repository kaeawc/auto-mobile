package dev.jasonpearson.automobile.ctrlproxy

/**
 * Routes WebSocket client lifecycle callbacks to the service state they release. The callbacks run
 * on the server's connection path, so work that suspends goes through [Host.launch].
 */
internal class ClientSessionRouter<C : Any>(private val host: Host<C>) {
  /** The per-client state a session holds, and the prototype that tracks attached hosts. */
  interface Host<C> {
    fun dropQueuedCommands(client: C)

    fun cancelGestureStreams(client: C)

    /** Fails the waiting host prototype requests sent to [client], or all of them when null. */
    fun failHostRequests(client: C?)

    fun launch(block: suspend () -> Unit)

    suspend fun prototypeClientCountChanged(count: Int, observerSession: Int)

    suspend fun prototypeClientConnected()
  }

  fun onClientDisconnected(client: C) {
    host.dropQueuedCommands(client)
    host.cancelGestureStreams(client)
    // Its in-flight host requests have no socket to answer on, even if another client remains.
    host.failHostRequests(client)
  }

  fun onClientCountChanged(count: Int, observerSession: Int) {
    if (count == 0) host.failHostRequests(null)
    host.launch { host.prototypeClientCountChanged(count, observerSession) }
  }

  fun onClientConnected() {
    host.launch { host.prototypeClientConnected() }
  }
}
