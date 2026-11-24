package dev.jasonpearson.automobile.prototype.appshell

/** Serialized by the host interaction lock; launch URLs wait for runtime initialization. */
internal class AppShellLinkInbox {
  private val pending = mutableListOf<String>()
  private var open: (suspend (String) -> Unit)? = null

  suspend fun receive(url: String) {
    val target = open
    if (target == null) pending += url else target(url)
  }

  suspend fun attach(target: suspend (String) -> Unit) {
    open = target
    val launch = pending.toList()
    pending.clear()
    launch.forEach { target(it) }
  }

  fun detach() {
    open = null
  }
}
