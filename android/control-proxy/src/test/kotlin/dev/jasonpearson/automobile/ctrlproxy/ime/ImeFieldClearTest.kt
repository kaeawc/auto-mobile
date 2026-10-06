package dev.jasonpearson.automobile.ctrlproxy.ime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImeFieldClearTest {
  @Test
  fun `clear finishes composition then reads both sides and deletes their UTF16 lengths`() {
    val calls = mutableListOf<String>()
    val result =
      clearImeField(
        finishComposing = {
          calls.add("finish")
          false
        },
        readBefore = { max ->
          calls.add("before:$max")
          "a😀"
        },
        readAfter = { max ->
          calls.add("after:$max")
          "tail"
        },
        deleteSurrounding = { before, after ->
          calls.add("delete:$before:$after")
          true
        },
      )
    assertTrue(result.success)
    assertEquals(listOf("finish", "before:100000", "after:100000", "delete:3:4"), calls)
  }

  @Test
  fun `empty or unavailable surrounding text preserves zero length deletion`() {
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
      assertTrue(deleted)
    }
  }

  @Test
  fun `rejected or throwing delete is a partial typed failure`() {
    for (throws in listOf(false, true)) {
      val result =
        clearImeField({ true }, { "old" }, { "" }) { _, _ ->
          if (throws) error("connection lost")
          false
        }
      assertFalse(result.success)
      assertTrue(result.partialApplication)
      assertEquals("IME clear failed", result.error)
    }
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
