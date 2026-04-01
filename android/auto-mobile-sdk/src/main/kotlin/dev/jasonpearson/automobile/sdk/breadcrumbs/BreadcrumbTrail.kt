package dev.jasonpearson.automobile.sdk.breadcrumbs

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

enum class BreadcrumbCategory {
    NAVIGATION, TAP, LIFECYCLE, NETWORK, LOG, CUSTOM
}

data class Breadcrumb(
    val timestamp: Long,
    val category: BreadcrumbCategory,
    val message: String,
    val metadata: Map<String, String> = emptyMap(),
)

interface BreadcrumbTracking {
    fun add(breadcrumb: Breadcrumb)
    fun snapshot(): List<Breadcrumb>
    fun clear()
}

/**
 * Thread-safe ring buffer of recent breadcrumbs.
 * When full, oldest breadcrumbs are evicted.
 */
class BreadcrumbTrail(private val maxSize: Int = 100) : BreadcrumbTracking {
    private val lock = ReentrantLock()
    private val deque = ArrayDeque<Breadcrumb>(maxSize)

    override fun add(breadcrumb: Breadcrumb) {
        lock.withLock {
            if (deque.size >= maxSize) {
                deque.removeFirst()
            }
            deque.addLast(breadcrumb.copy(metadata = breadcrumb.metadata.toMap()))
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
