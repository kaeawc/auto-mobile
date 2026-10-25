package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PrototypeChoreographyTest {
  private val rules = PrototypeChoreographyRules

  private fun ranks(order: String?, count: Int) = List(count) { rules.rank(it, count, order) }

  @Test
  fun `ranks follow the stagger order`() {
    assertEquals(listOf(0, 1, 2, 3), ranks(null, 4))
    assertEquals(listOf(0, 1, 2, 3), ranks("forward", 4))
    assertEquals(listOf(3, 2, 1, 0), ranks("reverse", 4))
    assertEquals(listOf(1, 0, 0, 1), ranks("center", 4))
    assertEquals(listOf(2, 1, 0, 1, 2), ranks("center", 5))
    assertEquals(listOf(0), ranks("center", 1))
  }

  @Test
  fun `a delay is the rank times ms plus the child's own delay`() {
    assertEquals(listOf(0, 60, 120), rules.delays(3, 60, null) { 0 })
    assertEquals(listOf(200, 60, 120), rules.delays(3, 60, null) { if (it == 0) 200 else 0 })
    assertEquals(listOf(120, 60, 0), rules.delays(3, 60, "reverse") { 0 })
  }

  @Test
  fun `a transition reads as its type alone or as a type with a delay`() {
    fun read(text: String) = Json.decodeFromString(PrototypeTransition.serializer(), text)
    assertEquals(PrototypeTransition("fade"), read("\"fade\""))
    assertEquals(
      PrototypeTransition("blurReplace", 120),
      read("""{"type":"blurReplace","delayMs":120}"""),
    )
    assertEquals(PrototypeTransition("scale"), read("""{"type":"scale"}"""))
  }

  @Test
  fun `a transition writes back in the shortest form`() {
    fun write(value: PrototypeTransition) =
      Json.encodeToString(PrototypeTransition.serializer(), value)
    assertEquals("\"fade\"", write(PrototypeTransition("fade")))
    assertEquals("""{"type":"fade","delayMs":40}""", write(PrototypeTransition("fade", 40)))
  }

  private fun spec(children: String, stagger: String) =
    """{"id":"a","window":{"placement":{"type":"fullscreen"}},"state":{"show":true},
      "root":{"type":"column","stagger":$stagger,"children":$children}}"""

  private fun visibleChildren(count: Int) =
    List(count) { """{"type":"text","text":"x","visibleWhen":{"key":"show","equals":true}}""" }
      .joinToString(prefix = "[", postfix = "]")

  @Test
  fun `the validator allows 600 ms in all and refuses more at the stagger`() {
    val ok = PrototypeSpecValidator.validate(spec(visibleChildren(7), """{"ms":100}"""))
    assertTrue(ok is PrototypeSpecValidation.Success, ok.toString())
    val tooLong = PrototypeSpecValidator.validate(spec(visibleChildren(8), """{"ms":100}"""))
    val error = (tooLong as PrototypeSpecValidation.Failure).error
    assertEquals("root.stagger", error.path)
    assertEquals("Stagger and transition delays add up to more than 600 ms", error.message)
  }

  @Test
  fun `an object transition decodes into the node model`() {
    val result =
      PrototypeSpecValidator.validate(
        """{"id":"a","window":{"placement":{"type":"fullscreen"}},"state":{"show":true},
          "root":{"type":"text","text":"x","visibleWhen":{"key":"show","equals":true},
          "transition":{"type":"blurReplace","delayMs":90}}}""",
      )
    val spec = (result as PrototypeSpecValidation.Success).spec
    assertEquals(PrototypeTransition("blurReplace", 90), spec.root.transition)
  }
}
