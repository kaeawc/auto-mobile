package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Before
import org.junit.Test

/**
 * Regression coverage for #3602: [captureProcessOutput] must drain the child's output concurrently
 * so a command whose output exceeds the OS pipe buffer (~64KB) does not deadlock and get reported
 * as a spurious failure.
 */
class CaptureProcessOutputTest {

  @Before
  fun onlyOnUnix() {
    // These tests spawn `sh`; the desktop-core unit-test job runs on Linux.
    assumeFalse(System.getProperty("os.name", "").lowercase().contains("windows"))
  }

  @Test
  fun capturesOutputLargerThanPipeBuffer() {
    // 200_000 lines of ~11 bytes ≈ 2MB, far beyond the ~64KB pipe buffer that used to deadlock the
    // old read-after-waitFor implementation.
    val lineCount = 200_000
    val process =
      ProcessBuilder("sh", "-c", "yes 'AUTOMOBILE' | head -n $lineCount")
        .redirectErrorStream(true)
        .start()

    val output = captureProcessOutput(process, 30, TimeUnit.SECONDS)

    assertTrue(output != null, "expected the large output to be captured, not a spurious null")
    val lines = output!!.trim().split("\n")
    assertEquals(lineCount, lines.size, "every emitted line should be captured")
    assertTrue(lines.all { it == "AUTOMOBILE" }, "captured content should be intact")
  }

  @Test
  fun capturesSmallOutput() {
    val process =
      ProcessBuilder("sh", "-c", "printf 'hello world'").redirectErrorStream(true).start()

    val output = captureProcessOutput(process, 5, TimeUnit.SECONDS)

    assertEquals("hello world", output)
  }

  @Test
  fun returnsNullOnTimeout() {
    val process = ProcessBuilder("sh", "-c", "sleep 10").redirectErrorStream(true).start()

    val output = captureProcessOutput(process, 1, TimeUnit.SECONDS)

    assertNull(output, "a command exceeding the timeout should be destroyed and yield null")
    // The timed-out process should have been destroyed; give it a brief moment to die.
    process.waitFor(2, TimeUnit.SECONDS)
    assertTrue(!process.isAlive, "timed-out process should have been destroyed")
  }

  @Test
  fun returnsNullOnNonZeroExit() {
    val process = ProcessBuilder("sh", "-c", "echo oops; exit 3").redirectErrorStream(true).start()

    val output = captureProcessOutput(process, 5, TimeUnit.SECONDS)

    assertNull(output, "a non-zero exit should yield null")
  }
}
