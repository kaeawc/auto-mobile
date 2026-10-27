package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeWindowMotionRulesTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmRules() {
      prototypeWindowTransition("auto", "floating", PrototypeMotionProfile.FULL)
      prototypeChildEntries(
        PrototypeColumnNode(
          repeat = PrototypeRepeat(listOf(mapOf("name" to PrototypeScalar.Text("A"))), "item"),
          children = listOf(PrototypeTextNode(text = "A")),
        ),
        "root",
      )
    }
  }

  @Test
  fun `window profile resolves spatial auto and explicit none`() {
    assertEquals("slide", prototypeWindowTransition("auto", "sheet", PrototypeMotionProfile.FULL))
    assertEquals(
      "scale",
      prototypeWindowTransition("auto", "floating", PrototypeMotionProfile.FULL),
    )
    assertEquals(
      "fade",
      prototypeWindowTransition("auto", "fullscreen", PrototypeMotionProfile.FULL),
    )
    assertEquals(
      "fade",
      prototypeWindowTransition("slide", "sheet", PrototypeMotionProfile.REDUCED),
    )
    assertEquals("none", prototypeWindowTransition("none", "sheet", PrototypeMotionProfile.REDUCED))
    assertEquals("none", prototypeWindowTransition("scale", "floating", PrototypeMotionProfile.OFF))
  }

  @Test
  fun `repeat delays use instance rank and cap combined choreography`() {
    val node =
      PrototypeColumnNode(
        repeat =
          PrototypeRepeat(
            List(9) { mapOf("name" to PrototypeScalar.Text("A")) },
            "item",
            stagger = 100,
          ),
        children =
          listOf(
            PrototypeTextNode(
              text = "A",
              visibleWhen =
                PrototypeCondition(key = "open", equals = PrototypeScalar.BooleanValue(true)),
            ),
            PrototypeTextNode(text = "Always"),
          ),
      )
    val entries = prototypeChildEntries(node, "root")
    assertEquals(
      listOf(0, 0, 100, 0, 200, 0, 300, 0, 400, 0, 500, 0, 600, 0, 600, 0, 600, 0),
      entries.map { it.enterDelayMs },
    )
  }
}
