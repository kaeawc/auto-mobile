package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.*
import org.junit.Test

class InsertTextSettleTest {
  private fun snapshot(text: String?, start: Int = -1, end: Int = start, hint: Boolean = false) =
    InsertTextSnapshot(text, hint, start, end)

  @Test
  fun `null baseline retains legacy suffix behavior`() {
    var polls = 0
    var pauses = 0
    assertTrue(
      awaitPrecedingInput(
        "x",
        {
          polls++
          snapshot("éx")
        },
        { 0L },
        { pauses++ },
      ),
    )
    assertEquals(1, polls)
    assertEquals(0, pauses)
  }

  @Test
  fun `waits until snapshot ends with suffix`() {
    var now = 0L
    var polls = 0
    val pauses = mutableListOf<Long>()
    val snapshots = listOf(snapshot("é"), snapshot("é"), snapshot("éx"))
    assertTrue(
      awaitPrecedingInput(
        "x",
        { snapshots[polls++] },
        { now },
        {
          pauses.add(it)
          now += it
        },
      ),
    )
    assertEquals(3, polls)
    assertEquals(listOf(25L, 25L), pauses)
  }

  @Test
  fun `deadline passes without suffix`() {
    var now = 0L
    var totalPause = 0L
    assertFalse(
      awaitPrecedingInput(
        "x",
        { snapshot("é") },
        { now },
        {
          now += it
          totalPause += it
        },
      ),
    )
    assertTrue(now >= 300L)
    assertTrue(totalPause <= 300L)
  }

  @Test
  fun `null snapshot node gone returns false`() {
    assertFalse(awaitPrecedingInput("x", { null }, { 0L }, { error("must not pause") }))
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
  fun `stale previous-insert text is refreshed until exact remembered content appears`() {
    var now = 0L
    var reads = 0
    assertTrue(
      awaitPrecedingInput(
        "",
        { if (++reads < 3) snapshot("é", 1) else snapshot("éx👍🏽", 1) },
        { now },
        { now += it },
        matches = { it.text == "éx👍🏽" },
      ),
    )
    assertEquals(50L, now)
    assertEquals(3, reads)
  }

  @Test
  fun `changed field never equals remembered content and waiting is bounded`() {
    var now = 0L
    assertFalse(
      awaitPrecedingInput(
        "",
        { snapshot("unrelated", 9) },
        { now },
        { now += it },
        matches = { it.text == "éx👍🏽" },
      ),
    )
    assertEquals(300L, now)
  }

  @Test
  fun `pre-existing suffix waits for repeated key event to land`() {
    var now = 0L
    var reads = 0
    val baseline = snapshot("éx", 2)
    assertFalse(isPrecedingInputReflected(baseline, "x", baseline))
    assertTrue(
      awaitPrecedingInput(
        "x",
        { if (++reads < 3) baseline else snapshot("éxx", 3) },
        { now },
        { now += it },
        baseline = baseline,
      ),
    )
    assertEquals(50L, now)
    assertEquals(3, reads)
  }

  @Test
  fun `pre-existing suffix with no change times out`() {
    var now = 0L
    val baseline = snapshot("éx", 2)
    assertFalse(awaitPrecedingInput("x", { baseline }, { now }, { now += it }, baseline = baseline))
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
  fun `transformed input takes bounded warning path`() {
    var now = 0L
    var reads = 0
    assertFalse(
      awaitPrecedingInput(
        "x",
        {
          reads++
          snapshot("éX", 2)
        },
        { now },
        { now += it },
        baseline = snapshot("é", 1),
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
