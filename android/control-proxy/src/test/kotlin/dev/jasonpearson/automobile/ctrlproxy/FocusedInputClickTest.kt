package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.BeforeClass
import org.junit.Test

class FocusedInputClickTest {
  companion object {
    @BeforeClass
    @JvmStatic
    fun initializeHelperClasses() {
      // Initialize helper, Kotlin collection and assertion classes before operation timings.
      FocusedInputClickTest().`clicks the focused input and recycles it`()
    }
  }

  @Test
  fun `clicks the focused input and recycles it`() {
    val node = Any()
    val events = mutableListOf<String>()
    val result =
      clickFocusedInput(
        findFocusedInput = { node },
        click = {
          assertSame(node, it)
          events.add("click")
          true
        },
        recycle = {
          assertSame(node, it)
          events.add("recycle")
        },
        settleAfterClick = { events.add("settle") },
      )
    assertEquals(FocusedInputClickOutcome(true, null), result)
    assertEquals(listOf("click", "recycle", "settle"), events)
  }

  @Test
  fun `missing focused input fails without clicking`() {
    val result =
      clickFocusedInput<Any>(
        findFocusedInput = { null },
        click = { error("Must not click") },
        recycle = { error("Must not recycle") },
      )
    assertEquals(FocusedInputClickOutcome(false, "No focused editable input"), result)
  }

  @Test
  fun `refused click fails and recycles the node`() {
    var recycled = false
    val result =
      clickFocusedInput(
        findFocusedInput = { Any() },
        click = { false },
        recycle = { recycled = true },
        settleAfterClick = { error("Refused clicks must not settle") },
      )
    assertEquals(FocusedInputClickOutcome(false, "Focused input click returned false"), result)
    assertEquals(true, recycled)
  }
}
