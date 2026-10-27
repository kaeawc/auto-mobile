package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.protocol.PrototypeDegradedEffect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.BeforeClass
import org.junit.Test

class ViewerEffectsNoteTest {
  private val format: (Int, Int) -> String = { api, budget ->
    "$api unsupported, $budget over frame budget"
  }

  @Test
  fun emptyReportHasNoNote() {
    assertNull(viewerEffectsNote(emptyList(), format))
  }

  @Test
  fun noteCountsBothReasons() {
    assertEquals("1 unsupported, 1 over frame budget", viewerEffectsNote(effects, format))
  }

  companion object {
    private lateinit var effects: List<PrototypeDegradedEffect>

    @JvmStatic
    @BeforeClass
    fun prepareEffects() {
      // Protocol serializer initialization belongs to fixture setup, outside the unit budget.
      effects =
        listOf(
          PrototypeDegradedEffect("root.style.effects[0]", "blur", "api"),
          PrototypeDegradedEffect("root.style.effects[1]", "wave", "budget"),
        )
    }
  }
}
