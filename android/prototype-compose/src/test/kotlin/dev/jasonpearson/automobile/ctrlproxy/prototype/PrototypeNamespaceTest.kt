package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAndroidNamespace
import dev.jasonpearson.automobile.protocol.PrototypeAndroidNamespacePredictiveBack
import dev.jasonpearson.automobile.protocol.PrototypeStackNode
import dev.jasonpearson.automobile.protocol.PrototypeTextNode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeNamespaceTest {
  @Test
  fun `indication respects namespace and motion setting`() {
    assertTrue(namespaceIndicationEnabled("ripple", true))
    assertTrue(namespaceIndicationEnabled(null, true))
    assertFalse(namespaceIndicationEnabled("none", true))
    assertFalse(namespaceIndicationEnabled("ripple", false))
  }

  @Test
  fun `back style only affects pops and respects reduced motion`() {
    fun stack(style: String) =
      PrototypeStackNode(
        id = "nav",
        start = "home",
        screens = mapOf("home" to PrototypeTextNode(text = "Home")),
        android =
          PrototypeAndroidNamespace(
            predictiveBack = PrototypeAndroidNamespacePredictiveBack(style),
          ),
      )
    val pop = PrototypeStackChange("nav", "pop")
    assertEquals(
      StackTransitionKind.None,
      namespaceStackAnimation(stack("none"), pop, true, false).kind,
    )
    assertEquals(
      StackTransitionKind.Slide,
      namespaceStackAnimation(stack("default"), pop, true, false).kind,
    )
    assertEquals(
      StackTransitionKind.SharedAxisX,
      namespaceStackAnimation(stack("crossActivity"), pop, true, false).kind,
    )
    assertEquals(
      StackTransitionKind.Fade,
      namespaceStackAnimation(stack("crossActivity"), pop, true, true).kind,
    )
    assertEquals(
      StackTransitionKind.None,
      namespaceStackAnimation(stack("crossActivity"), pop, false, false).kind,
    )
    assertEquals(
      StackTransitionKind.Slide,
      namespaceStackAnimation(stack("none"), null, true, false).kind,
    )
  }
}
