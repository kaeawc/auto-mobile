package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class InsertTextSettleTest {
  private fun snapshot(text: String?, start: Int = -1, end: Int = start, hint: Boolean = false) =
    InsertTextSnapshot(text, hint, start, end)

  @Test
  fun `null baseline retains legacy suffix behavior`() = runTest {
    var polls = 0
    var pauses = 0
    assertTrue(
      awaitPrecedingInput(
        PrecedingInputExpectation("x"),
        readSnapshot = {
          polls++
          snapshot("éx")
        },
        nowMs = { 0L },
        pause = { pauses++ },
      ),
    )
    assertEquals(1, polls)
    assertEquals(0, pauses)
  }

  @Test
  fun `waits until snapshot ends with suffix`() = runTest {
    var now = 0L
    var polls = 0
    val pauses = mutableListOf<Long>()
    val snapshots = listOf(snapshot("é"), snapshot("é"), snapshot("éx"))
    assertTrue(
      awaitPrecedingInput(
        PrecedingInputExpectation("x"),
        readSnapshot = { snapshots[polls++] },
        nowMs = { now },
        pause = {
          pauses.add(it)
          now += it
        },
      ),
    )
    assertEquals(3, polls)
    assertEquals(listOf(25L, 25L), pauses)
  }

  @Test
  fun `deadline passes without suffix`() = runTest {
    var now = 0L
    var totalPause = 0L
    assertFalse(
      awaitPrecedingInput(
        PrecedingInputExpectation("x"),
        readSnapshot = { snapshot("é") },
        nowMs = { now },
        pause = {
          now += it
          totalPause += it
        },
      ),
    )
    assertTrue(now >= 300L)
    assertTrue(totalPause <= 300L)
  }

  @Test
  fun `null snapshot node gone returns false`() = runTest {
    assertFalse(
      awaitPrecedingInput(
        PrecedingInputExpectation("x"),
        readSnapshot = { null },
        nowMs = { 0L },
        pause = { error("must not pause") },
      ),
    )
  }

  @Test
  fun `mid-text selection counts text before caret`() {
    assertTrue(isPrecedingInputReflected(snapshot("helxlo", 4), "x"))
    assertTrue(isPrecedingInputReflected(snapshot("helxlo", 2, 4), "x"))
    assertFalse(isPrecedingInputReflected(snapshot("helxlo", 4, 9), "x"))
  }

  @Test
  fun `hint text is treated as empty`() {
    assertFalse(isPrecedingInputReflected(snapshot("x", 1, hint = true), "x"))
    assertFalse(isPrecedingInputReflected(snapshot(null), "x"))
  }

  @Test
  fun `stale previous-insert text is refreshed until exact remembered content appears`() = runTest {
    var now = 0L
    var reads = 0
    assertTrue(
      awaitPrecedingInput(
        PrecedingInputExpectation("", matches = { it.text == "éx👍🏽" }),
        readSnapshot = { if (++reads < 3) snapshot("é", 1) else snapshot("éx👍🏽", 1) },
        nowMs = { now },
        pause = { now += it },
      ),
    )
    assertEquals(50L, now)
    assertEquals(3, reads)
  }

  @Test
  fun `changed field never equals remembered content and waiting is bounded`() = runTest {
    var now = 0L
    assertFalse(
      awaitPrecedingInput(
        PrecedingInputExpectation("", matches = { it.text == "éx👍🏽" }),
        readSnapshot = { snapshot("unrelated", 9) },
        nowMs = { now },
        pause = { now += it },
      ),
    )
    assertEquals(300L, now)
  }

  @Test
  fun `pre-existing suffix waits for repeated key event to land`() = runTest {
    var now = 0L
    var reads = 0
    val baseline = snapshot("éx", 2)
    assertFalse(isPrecedingInputReflected(baseline, "x", baseline))
    assertTrue(
      awaitPrecedingInput(
        PrecedingInputExpectation("x", baseline = baseline),
        readSnapshot = { if (++reads < 3) baseline else snapshot("éxx", 3) },
        nowMs = { now },
        pause = { now += it },
      ),
    )
    assertEquals(50L, now)
    assertEquals(3, reads)
  }

  @Test
  fun `pre-existing suffix with no change times out`() = runTest {
    var now = 0L
    val baseline = snapshot("éx", 2)
    assertFalse(
      awaitPrecedingInput(
        PrecedingInputExpectation("x", baseline = baseline),
        readSnapshot = { baseline },
        nowMs = { now },
        pause = { now += it },
      ),
    )
    assertEquals(300L, now)
  }

  @Test
  fun `exact insertion and selection replacement reflect a change`() {
    assertTrue(isPrecedingInputReflected(snapshot("éx", 2), "x", snapshot("é", 1)))
    assertTrue(isPrecedingInputReflected(snapshot("helxlo", 4), "x", snapshot("hello", 3)))
    assertTrue(isPrecedingInputReflected(snapshot("axc", 2), "x", snapshot("abc", 1, 2)))
    assertFalse(isPrecedingInputReflected(snapshot("éxx", 3), "x", snapshot("éx", -1)))
  }

  @Test
  fun `replacing identical selected text needs selection change`() {
    val baseline = snapshot("éx", 1, 2)
    assertFalse(isPrecedingInputReflected(baseline, "x", baseline))
    assertTrue(isPrecedingInputReflected(snapshot("éx", 2), "x", baseline))
    assertFalse(isPrecedingInputReflected(snapshot("éx", 0), "x", baseline))
  }

  @Test
  fun `transformed input takes bounded warning path`() = runTest {
    var now = 0L
    var reads = 0
    assertFalse(
      awaitPrecedingInput(
        PrecedingInputExpectation("x", baseline = snapshot("é", 1)),
        readSnapshot = {
          reads++
          snapshot("éX", 2)
        },
        nowMs = { now },
        pause = { now += it },
      ),
    )
    assertEquals(300L, now)
    assertEquals(13, reads)
  }

  @Test
  fun `empty or null expectation is not waited on`() {
    assertFalse(shouldWaitForPrecedingInput(null))
    assertFalse(shouldWaitForPrecedingInput(""))
    assertTrue(shouldWaitForPrecedingInput("x"))
  }
}
