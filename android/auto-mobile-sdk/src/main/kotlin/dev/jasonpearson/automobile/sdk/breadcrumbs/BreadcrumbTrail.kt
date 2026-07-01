package dev.jasonpearson.automobile.sdk.breadcrumbs

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Category for classifying breadcrumbs in crash reports and diagnostics. */
enum class BreadcrumbCategory {
  /** A navigation event between screens. */
  NAVIGATION,
  /** A user tap interaction. */
  TAP,
  /** An Activity or Fragment lifecycle transition. */
  LIFECYCLE,
  /** A network request or response. */
  NETWORK,
  /** A log message captured as a breadcrumb. */
  LOG,
  /** A custom breadcrumb added by app code. */
  CUSTOM,
}

/**
 * A single breadcrumb entry representing a discrete app event.
 *
 * @property timestamp Unix epoch millis when the breadcrumb was recorded
 * @property category The classification of this breadcrumb
 * @property message A short human-readable description
 * @property metadata Optional key-value pairs with extra context
 */
data class Breadcrumb(
    val timestamp: Long,
    val category: BreadcrumbCategory,
    val message: String,
    val metadata: Map<String, String> = emptyMap(),
)

/** Interface for collecting and retrieving breadcrumbs. */
interface BreadcrumbTracking {
  /** Adds a breadcrumb to the trail. */
  fun add(breadcrumb: Breadcrumb)

  /** Returns an immutable copy of all breadcrumbs in chronological order. */
  fun snapshot(): List<Breadcrumb>

  /** Removes all breadcrumbs. */
  fun clear()
}

/** Thread-safe ring buffer of recent breadcrumbs. When full, oldest breadcrumbs are evicted. */
class BreadcrumbTrail(private val maxSize: Int = 100) : BreadcrumbTracking {
  private val lock = ReentrantLock()
  private val deque = ArrayDeque<Breadcrumb>(maxSize)

  override fun add(breadcrumb: Breadcrumb) {
    lock.withLock {
      if (deque.size >= maxSize) {
        deque.removeFirst()
      }
      deque.addLast(breadcrumb)
    }
  }

  override fun snapshot(): List<Breadcrumb> {
    lock.withLock {
      return ArrayList(deque)
    }
  }

  override fun clear() {
    lock.withLock { deque.clear() }
  }
}
