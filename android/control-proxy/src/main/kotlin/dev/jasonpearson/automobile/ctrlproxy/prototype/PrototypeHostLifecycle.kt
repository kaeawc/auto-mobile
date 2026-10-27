package dev.jasonpearson.automobile.ctrlproxy.prototype

/** Dismissal and teardown share the same contract across platform and fake hosts. */
interface PrototypeHostLifecycle {
  /**
   * Starts dismissal, allowing the app to regain focus while an animated exit finishes. A window
   * already detached counts as removed; other failed removals are retryable.
   */
  suspend fun dismiss(): Boolean

  /** Removes without waiting for an exit animation. */
  suspend fun dismissImmediately(): Boolean = dismiss()

  /**
   * Terminal for show/replace; dismiss may still retry a failed platform removal. Invalidates
   * pending restores, but does not cancel caller-owned gesture blocks.
   */
  suspend fun destroy(): Boolean
}
