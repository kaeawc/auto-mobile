package dev.jasonpearson.automobile.desktop.core.diagnostics

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext

/** How often the workspace status re-runs the system checks; each run spawns a few processes. */
const val DIAGNOSTIC_ROLLUP_REFRESH_MS: Long = 5 * 60_000L

/** How many [checks] failed outright; warnings and optional tools do not count. */
internal fun countFailingChecks(checks: List<DiagnosticCheck>): Int = checks.count {
  it.status == DiagnosticStatus.Error
}

/** Run the Diagnostics system checks and count the failing ones. Blocking: spawns processes. */
fun failingDiagnosticCheckCount(): Int = countFailingChecks(runSystemChecks())

/**
 * The failing system-check count for the workspace status roll-up (#4857): [count] runs on
 * [dispatcher] now and every [refreshMs], and only changes are emitted.
 */
fun failingDiagnosticChecks(
  count: () -> Int = ::failingDiagnosticCheckCount,
  refreshMs: Long = DIAGNOSTIC_ROLLUP_REFRESH_MS,
  dispatcher: CoroutineDispatcher = Dispatchers.IO,
): Flow<Int> = flow {
  while (true) {
    emit(withContext(dispatcher) { count() })
    delay(refreshMs)
  }
}
  .distinctUntilChanged()
