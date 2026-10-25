package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.EnterTransition
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class PrototypeChoreographyMotionTest {
  private val condition = PrototypeCondition("show", PrototypeScalar.BooleanValue(true))

  private fun child(transition: PrototypeTransition? = null, visible: Boolean = true) =
    PrototypeTextNode(
      text = "x",
      visibleWhen = if (visible) condition else null,
      transition = transition,
    )

  @Test
  fun `only visibleWhen children are staggered, in layout order`() {
    val column =
      PrototypeColumnNode(
        stagger = PrototypeStagger(50),
        children = listOf(child(), child(visible = false), child(), child()),
      )
    assertEquals(listOf(0, 0, 50, 100), prototypeStaggerDelays(column, column.children))
  }

  @Test
  fun `reverse and center orders rank from the other end and the middle`() {
    fun delays(order: String): List<Int> {
      val column =
        PrototypeRowNode(
          stagger = PrototypeStagger(10, order),
          children = List(5) { child() },
        )
      return prototypeStaggerDelays(column, column.children)
    }
    assertEquals(listOf(40, 30, 20, 10, 0), delays("reverse"))
    assertEquals(listOf(20, 10, 0, 10, 20), delays("center"))
  }

  @Test
  fun `a container without stagger waits for no child`() {
    val box = PrototypeBoxNode(children = listOf(child(), child()))
    assertEquals(listOf(0, 0), prototypeStaggerDelays(box, box.children))
    val text = PrototypeTextNode(text = "x")
    assertEquals(listOf(0), prototypeStaggerDelays(text, listOf(child())))
  }

  @Test
  fun `the render model adds a child's own delay to its stagger and caps the total`() {
    val column =
      PrototypeColumnNode(
        stagger = PrototypeStagger(100),
        children =
          listOf(
            child(PrototypeTransition("fade", 30)),
            child(PrototypeTransition("fade", 600)),
            child(),
          ),
      )
    val spec = PrototypeSpec("a", PrototypeWindow(PrototypeFullscreenPlacement()), root = column)
    val delays = mapPrototypeSpec(spec).root.children.map { it.enterDelayMs }
    assertEquals(listOf(30, 600, 200), delays)
  }

  @Test
  fun `a delayed enter is a different animation than the same enter with none`() {
    for (type in listOf("fade", "expand", "slide", "slideStart", "scale", "blurReplace", null)) {
      val now = prototypeEnterTransition(type)
      val later = prototypeEnterTransition(type, delayMs = 120)
      assertNotEquals(type, now, later)
      assertNotEquals(type, EnterTransition.None, later)
    }
  }

  @Test
  fun `none stays none however long the delay`() {
    assertEquals(EnterTransition.None, prototypeEnterTransition("none", delayMs = 120))
  }
}
