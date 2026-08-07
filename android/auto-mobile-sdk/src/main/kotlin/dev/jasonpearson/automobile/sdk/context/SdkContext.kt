package dev.jasonpearson.automobile.sdk.context

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Thread-safe mutable context holding ambient state attached to SDK events. */
internal class SdkContext {
  private val lock = ReentrantLock()

  @Volatile var sessionId: String? = null
  @Volatile var userId: String? = null
  @Volatile var tenantId: String? = null
  @Volatile var currentScreen: String? = null
  @Volatile var appVersion: String? = null

  private val _tags = mutableMapOf<String, String>()

  fun setTag(key: String, value: String) {
    lock.withLock { _tags[key] = value }
  }

  fun removeTag(key: String) {
    lock.withLock { _tags.remove(key) }
  }

  fun clearTags() {
    lock.withLock { _tags.clear() }
  }

  /** Returns an immutable snapshot of the current context. */
  fun snapshot(): SdkContextSnapshot {
    lock.withLock {
      return SdkContextSnapshot(
        sessionId = sessionId,
        userId = userId,
        tenantId = tenantId,
        currentScreen = currentScreen,
        appVersion = appVersion,
        tags = HashMap(_tags),
      )
    }
  }

  /** Reset all context to defaults. */
  fun reset() {
    lock.withLock {
      sessionId = null
      userId = null
      tenantId = null
      currentScreen = null
      appVersion = null
      _tags.clear()
    }
  }
}

/** Immutable snapshot of SDK context at a point in time. */
data class SdkContextSnapshot(
  val sessionId: String?,
  val userId: String?,
  val appVersion: String?,
  val tags: Map<String, String>,
  val tenantId: String? = null,
  val currentScreen: String? = null,
) {
  /** Preserves the pre-context-extension constructor for binary compatibility. */
  constructor(
    sessionId: String?,
    userId: String?,
    appVersion: String?,
    tags: Map<String, String>,
  ) : this(sessionId, userId, appVersion, tags, null, null)
}
