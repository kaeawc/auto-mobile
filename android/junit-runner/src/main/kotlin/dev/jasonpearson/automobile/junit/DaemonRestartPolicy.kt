package dev.jasonpearson.automobile.junit

internal object DaemonRestartPolicy {
  /**
   * Resolve whether to force a daemon restart before reuse. Explicit configuration wins (JVM
   * property `automobile.daemon.force.restart` or env `AUTOMOBILE_DAEMON_FORCE_RESTART`); otherwise
   * CI runs default to true so a stale daemon left by a previous job is replaced rather than
   * silently reused (#2744 interim). See [shouldForceRestart] for the decision.
   */
  fun resolveForceRestart(): Boolean {
    val property = SystemPropertyCache.get("automobile.daemon.force.restart", "").ifBlank { null }
    val env = System.getenv("AUTOMOBILE_DAEMON_FORCE_RESTART")
    val ci = System.getenv("CI")
    return shouldForceRestart(property, env, ci)
  }

  /**
   * Pure force-restart decision. Explicit property/env values (parsed as booleans) win in order;
   * when neither is set, a truthy `CI` marker defaults to true. Unset/blank/unparseable values fall
   * through, defaulting to false outside CI.
   */
  internal fun shouldForceRestart(
    propertyValue: String?,
    envValue: String?,
    ciValue: String?,
  ): Boolean {
    parseBooleanFlag(propertyValue)?.let {
      return it
    }
    parseBooleanFlag(envValue)?.let {
      return it
    }
    return parseBooleanFlag(ciValue) ?: false
  }

  /**
   * Whether a requested forced restart must actually stop the running daemon (#10170).
   *
   * The forced restart exists to replace a stale daemon left by an earlier job. A daemon that
   * started after this run began ([resolveRunnerStartedAtMs]) was started by another runner of the
   * same run (a parallel Gradle fork), so restarting it again would stop that runner's in-flight
   * plans. When either start time is unknown the restart is kept, as before. An unavailable daemon
   * is always (re)started.
   */
  internal fun requiresForcedRestart(
    forceRestart: Boolean,
    daemonAvailable: Boolean,
    daemonStartedAtMs: Long?,
    runnerStartedAtMs: Long?,
  ): Boolean {
    if (!forceRestart) return false
    if (!daemonAvailable || daemonStartedAtMs == null || runnerStartedAtMs == null) return true
    return daemonStartedAtMs <= runnerStartedAtMs
  }

  internal fun parseBooleanFlag(value: String?): Boolean? {
    val normalized = value?.trim()?.lowercase() ?: return null
    return when (normalized) {
      "1",
      "true",
      "yes",
      "y" -> true
      "0",
      "false",
      "no",
      "n" -> false
      else -> null
    }
  }

  /** System property carrying one start timestamp (epoch ms) shared by every fork of a build. */
  const val RUN_STARTED_AT_PROPERTY = "automobile.junit.runStartedAtMs"

  /**
   * When this test run started (epoch ms), compared with the daemon's `startedAt` to decide whether
   * a forced restart is still needed (#10170). A build-wide [RUN_STARTED_AT_PROPERTY] wins, so a
   * fork started after a sibling restarted the daemon does not restart it again; without it this
   * JVM's start time ([jvmStartedAtMs]) is used.
   */
  internal fun resolveRunnerStartedAtMs(
    runStartedAtProperty: String?,
    jvmStartedAtMs: () -> Long?,
  ): Long? = runStartedAtProperty?.trim()?.toLongOrNull()?.takeIf { it > 0 } ?: jvmStartedAtMs()
}
