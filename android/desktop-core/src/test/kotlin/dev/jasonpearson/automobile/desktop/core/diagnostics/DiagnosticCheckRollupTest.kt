package dev.jasonpearson.automobile.desktop.core.diagnostics

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DiagnosticCheckRollupTest {

  @Test
  fun `only failed checks count`() {
    val checks =
      listOf(
        DiagnosticCheck("ADB", DiagnosticStatus.Error, "Not found in PATH"),
        DiagnosticCheck("Node.js", DiagnosticStatus.Success, "v22"),
        DiagnosticCheck("ANDROID_HOME", DiagnosticStatus.Warning, "Not set"),
        DiagnosticCheck("Bun", DiagnosticStatus.Info, "Not installed (optional)"),
        DiagnosticCheck("Java", DiagnosticStatus.Error, "Not found"),
      )
    assertEquals(2, countFailingChecks(checks))
  }

  @Test
  fun `re-runs the checks on its interval and emits only changes`() = runTest {
    val results = ArrayDeque(listOf(1, 1, 0))
    var runs = 0
    val emitted = mutableListOf<Int>()
    val job = launch {
      failingDiagnosticChecks(
          count = {
            runs++
            results.removeFirst()
          },
          refreshMs = 1_000,
          dispatcher = StandardTestDispatcher(testScheduler),
        )
        .collect { emitted += it }
    }
    runCurrent()
    assertEquals(listOf(1), emitted)

    advanceTimeBy(1_001)
    assertEquals(2, runs)
    assertEquals(listOf(1), emitted)

    advanceTimeBy(1_000)
    assertEquals(3, runs)
    assertEquals(listOf(1, 0), emitted)
    job.cancel()
  }
}
