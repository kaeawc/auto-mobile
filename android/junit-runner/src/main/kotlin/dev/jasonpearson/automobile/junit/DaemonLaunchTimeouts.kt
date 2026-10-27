package dev.jasonpearson.automobile.junit

internal object DaemonLaunchTimeouts {
  internal const val DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 30000L

  internal const val DAEMON_STARTUP_LIFECYCLE_BUDGETS = 3L

  internal const val DAEMON_LAUNCHER_FINAL_READINESS_CHECK_TIMEOUT_MS = 10000L

  internal const val DAEMON_LAUNCHER_TIMED_OUT_PROCESS_STOP_TIMEOUT_MS = 10000L

  internal const val DAEMON_LAUNCHER_POST_TIMEOUT_OVERHEAD_MS =
    DAEMON_LAUNCHER_FINAL_READINESS_CHECK_TIMEOUT_MS +
      DAEMON_LAUNCHER_TIMED_OUT_PROCESS_STOP_TIMEOUT_MS

  internal const val DAEMON_INCOMPLETE_EXTRACTION_CLEANUP_ALLOWANCE_MS =
    DEFAULT_DAEMON_STARTUP_TIMEOUT_MS

  internal const val DAEMON_RESTART_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10000L

  internal const val DAEMON_RESTART_FORCE_STOP_TIMEOUT_MS = 1000L

  internal const val DAEMON_RESTART_DELAY_MS = 1000L

  internal const val DAEMON_RESTART_OVERHEAD_MS =
    DAEMON_RESTART_GRACEFUL_SHUTDOWN_TIMEOUT_MS +
      DAEMON_RESTART_FORCE_STOP_TIMEOUT_MS +
      DAEMON_RESTART_DELAY_MS

  fun daemonStartTimeoutMs(): Long {
    // Check system property first, then environment variable
    val sysProp = SystemPropertyCache.get("automobile.daemon.startup.timeout.ms", "")
    val envVar = System.getenv("AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS")?.trim().orEmpty()
    val configured =
      sysProp.ifEmpty { envVar }.ifEmpty { DEFAULT_DAEMON_STARTUP_TIMEOUT_MS.toString() }
    return configured.toLongOrNull() ?: DEFAULT_DAEMON_STARTUP_TIMEOUT_MS
  }

  /**
   * Bound the launcher process for the daemon's full startup lifecycle: one lock-holder wait plus
   * up to two startup attempts. A timed-out attempt may then perform a bounded final readiness
   * check and process teardown. A retryable incomplete extraction needs one cleanup allowance
   * before the fallback launch; restarts also budget their bounded shutdown and delay phases.
   */
  fun daemonLauncherTimeoutMs(isRestart: Boolean): Long {
    val lifecycleOverheadMs =
      DAEMON_LAUNCHER_POST_TIMEOUT_OVERHEAD_MS +
        DAEMON_INCOMPLETE_EXTRACTION_CLEANUP_ALLOWANCE_MS +
        if (isRestart) DAEMON_RESTART_OVERHEAD_MS else 0L
    val startupTimeoutMs = daemonStartTimeoutMs()
    val maximumStartupTimeoutMs =
      (Long.MAX_VALUE - lifecycleOverheadMs) / DAEMON_STARTUP_LIFECYCLE_BUDGETS

    return if (startupTimeoutMs > maximumStartupTimeoutMs) {
      Long.MAX_VALUE
    } else {
      startupTimeoutMs * DAEMON_STARTUP_LIFECYCLE_BUDGETS + lifecycleOverheadMs
    }
  }
}
