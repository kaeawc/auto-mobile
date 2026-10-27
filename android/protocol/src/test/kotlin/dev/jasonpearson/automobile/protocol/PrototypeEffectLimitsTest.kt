package dev.jasonpearson.automobile.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** The Kotlin twin of `prototypeEffects.test.ts` (#15128): same limits, same first-error paths. */
class PrototypeEffectLimitsTest {
  private val noise = """{"type":"noise"}"""
  private val animated = """{"type":"noise","animate":{"periodMs":1000}}"""

  private fun many(count: Int, effect: String) = List(count) { effect }.joinToString(",")

  private fun label(effects: String, text: String = "t") =
    """{"type":"text","text":"$text","style":{"effects":[$effects]}}"""

  private fun nodes(count: Int, effect: String) = List(count) { label(many(4, effect), "n$it") }

  private fun spec(root: String, extra: String = "") =
    """{"id":"a","window":{"placement":{"type":"fullscreen"}}$extra,"root":$root}"""

  private fun column(children: List<String>) =
    """{"type":"column","children":[${children.joinToString(",")}]}"""

  private fun failure(json: String) =
    (PrototypeSpecValidator.validate(json) as PrototypeSpecValidation.Failure).error

  private fun assertValid(json: String) {
    val result = PrototypeSpecValidator.validate(json)
    assertTrue(result is PrototypeSpecValidation.Success, result.toString())
  }

  @Test
  fun `the contract names the limits`() {
    assertEquals(64, PrototypeSpecValidator.MAX_PROTOTYPE_EFFECTS)
    assertEquals(8, PrototypeSpecValidator.MAX_PROTOTYPE_ANIMATED_EFFECTS)
  }

  @Test
  fun `64 effects pass and the 65th fails at the node that crossed the limit`() {
    assertValid(spec(column(nodes(16, noise))))
    val error = failure(spec(column(nodes(16, noise) + label(noise, "extra"))))
    assertEquals("root.children[16]", error.path)
    assertEquals("Effect limit exceeded", error.message)
  }

  @Test
  fun `8 animated effects pass and the 9th fails`() {
    assertValid(spec(column(nodes(2, animated) + nodes(14, noise))))
    val error =
      failure(spec(column(nodes(2, animated) + label(animated, "ninth") + nodes(13, noise))))
    assertEquals("root.children[2]", error.path)
    assertEquals("Animated effect limit exceeded", error.message)
  }

  @Test
  fun `a styleWhen style's effects count too`() {
    val withWhen =
      """{"type":"text","text":"t","style":{"effects":[${many(4, noise)}]},
        "styleWhen":[{"when":{"key":"on","equals":true},"style":{"effects":[${many(4, noise)}]}}]}"""
    val error = failure(spec(column(List(9) { withWhen }), extra = ""","state":{"on":true}"""))
    assertEquals("Effect limit exceeded", error.message)
  }

  @Test
  fun `a repeat multiplies a template's effects and reports at the repeat`() {
    fun repeated(count: Int, template: String) =
      """{"type":"column","repeat":{"items":[${List(count) { """{"id":$it}""" }.joinToString(",")}],"as":"item"},
        "children":[$template]}"""
    assertValid(spec(repeated(16, label(many(4, noise)))))
    val over = failure(spec(repeated(17, label(many(4, noise)))))
    assertEquals("root.repeat", over.path)
    assertEquals("Expanded effect limit exceeded", over.message)
    val overAnimated = failure(spec(repeated(3, label(many(4, animated)))))
    assertEquals("root.repeat", overAnimated.path)
    assertEquals("Expanded animated effect limit exceeded", overAnimated.message)
  }

  @Test
  fun `an over-long list is reported as that, not as a count overflow`() {
    val error = failure(spec(column(nodes(15, noise) + label(many(5, noise), "long"))))
    assertEquals("root.children[15].style.effects", error.path)
  }
}
