package dev.jasonpearson.automobile.ctrlproxy.ime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImeFieldClearTest {
  @Test
  fun `clear finishes composition then reads both sides and deletes their UTF16 lengths`() {
    val calls = mutableListOf<String>()
    var deleted = false
    val result =
      clearImeField(
        finishComposing = {
          calls.add("finish")
          false
        },
        readBefore = { max ->
          calls.add("before:$max")
          if (deleted) "" else "a😀"
        },
        readAfter = { max ->
          calls.add("after:$max")
          if (deleted) "" else "tail"
        },
        deleteSurrounding = { before, after ->
          calls.add("delete:$before:$after")
          deleted = true
          true
        },
      )
    assertTrue(result.success)
    assertEquals(
      listOf(
        "finish",
        "before:100000",
        "after:100000",
        "delete:3:4",
        "before:100000",
        "after:100000",
      ),
      calls,
    )
  }

  @Test
  fun `empty or unavailable surrounding text succeeds without deletion`() {
    for (text in listOf(null, "")) {
      var deleted = false
      val result =
        clearImeField({ true }, { text }, { text }) { before, after ->
          assertEquals(0, before)
          assertEquals(0, after)
          deleted = true
          true
        }
      assertTrue(result.success)
      assertFalse(deleted)
      assertFalse(result.partialApplication)
    }
  }

  @Test
  fun `rejected or throwing delete is a partial typed failure`() {
    for (throws in listOf(false, true)) {
      var reads = 0
      var deletions = 0
      val result =
        clearImeField(
          { true },
          {
            reads++
            "old"
          },
          { "" },
        ) { _, _ ->
          deletions++
          if (throws) error("connection lost")
          false
        }
      assertFalse(result.success)
      assertTrue(result.partialApplication)
      assertEquals("IME clear failed", result.error)
      assertEquals(1, reads)
      assertEquals(1, deletions)
    }
  }

  @Test
  fun `clear repeats bounded reads until both sides are empty`() {
    var beforeRemaining = 250_003
    var afterRemaining = 150_007
    val window = "x".repeat(100_000)
    val deletions = mutableListOf<Pair<Int, Int>>()
    val result =
      clearImeField(
        { true },
        { max -> window.take(minOf(max, beforeRemaining)) },
        { max -> window.take(minOf(max, afterRemaining)) },
      ) { before, after ->
        deletions.add(before to after)
        beforeRemaining -= before
        afterRemaining -= after
        true
      }
    assertTrue(result.success)
    assertEquals(listOf(100_000 to 100_000, 100_000 to 50_007, 50_003 to 0), deletions)
    assertEquals(0, beforeRemaining)
    assertEquals(0, afterRemaining)
  }

  @Test
  fun `nonconverging editor fails at the deletion bound`() {
    var beforeReads = 0
    var afterReads = 0
    var deletions = 0
    val result =
      clearImeField(
        { true },
        {
          beforeReads++
          "remaining"
        },
        {
          afterReads++
          ""
        },
      ) { _, _ ->
        deletions++
        true
      }
    assertFalse(result.success)
    assertTrue(result.partialApplication)
    assertEquals("IME clear failed", result.error)
    assertEquals(16, deletions)
    assertEquals(17, beforeReads)
    assertEquals(17, afterReads)
  }

  @Test
  fun `clear can succeed on the final bounded deletion`() {
    var remaining = 16
    val result =
      clearImeField({ true }, { "" }, { if (remaining > 0) "x" else "" }) { before, after ->
        assertEquals(0, before)
        assertEquals(1, after)
        remaining--
        true
      }
    assertTrue(result.success)
    assertEquals(0, remaining)
  }

  @Test
  fun `read failure after a deletion preserves partial application`() {
    var deletions = 0
    val result =
      clearImeField({ true }, { if (deletions > 0) error("connection lost") else "old" }, { "" }) {
        _,
        _ ->
        deletions++
        true
      }
    assertFalse(result.success)
    assertTrue(result.partialApplication)
    assertEquals(1, deletions)
  }

  @Test
  fun `failed read cannot claim a successful clear or attempt deletion`() {
    var deleted = false
    val result =
      clearImeField({ true }, { error("connection lost") }, { "" }) { _, _ ->
        deleted = true
        true
      }
    assertFalse(result.success)
    assertFalse(deleted)
    assertFalse(result.partialApplication)
  }
}
