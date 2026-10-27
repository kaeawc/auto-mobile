package dev.jasonpearson.automobile.ctrlproxy.prototype

/** Keep outgoing windows observable and their assets readable until actual detach. */
class PrototypeExitResources {
  private data class Exit(
    val finish: () -> Unit,
    val surfaceId: String?,
    val metadata: () -> PrototypeWindowMetadata?,
  )

  private val owners = linkedMapOf<Any, Exit>()
  private var cleanup: (() -> Unit)? = null

  @Synchronized
  fun retain(
    owner: Any,
    finish: () -> Unit = {},
    surfaceId: String? = null,
    metadata: () -> PrototypeWindowMetadata? = { null },
  ) {
    owners[owner] = Exit(finish, surfaceId, metadata)
  }

  fun release(owner: Any) {
    val pending =
      synchronized(this) {
        owners.remove(owner)
        if (owners.isEmpty()) cleanup.also { cleanup = null } else null
      }
    pending?.invoke()
  }

  fun whenIdle(block: () -> Unit) {
    val idle =
      synchronized(this) {
        if (owners.isEmpty()) true
        else {
          cleanup = block
          false
        }
      }
    if (idle) block()
  }

  fun drain() {
    val (exits, pending) =
      synchronized(this) {
        (owners.values.toList() to cleanup).also {
          owners.clear()
          cleanup = null
        }
      }
    exits.forEach { it.finish() }
    pending?.invoke()
  }

  @Synchronized
  fun count(surfaceId: String?): Int =
    owners.values.count { surfaceId == null || it.surfaceId == surfaceId }

  fun metadata(surfaceId: String?): PrototypeWindowMetadata? {
    val exit =
      synchronized(this) {
        owners.values.lastOrNull { surfaceId == null || it.surfaceId == surfaceId }
      } ?: return null
    val result = exit.metadata() ?: return null
    val motion = result.motion ?: PrototypeMotionState.Settled
    return result.copy(
      opaque = false,
      motion = motion.copy(active = motion.active.coerceAtLeast(1)),
    )
  }
}
