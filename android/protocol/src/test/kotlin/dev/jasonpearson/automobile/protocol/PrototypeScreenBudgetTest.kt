package dev.jasonpearson.automobile.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class PrototypeScreenBudgetTest {
  private fun budget() = PrototypeScreenBudget(10, 4, 25, 8)

  @Test
  fun `sibling screens are budgeted separately`() {
    val budget = budget()
    budget.enterStack()
    repeat(2) {
      budget.enterScreen()
      assertNull(budget.charge(10, 4))
      budget.exitScreen()
    }
    budget.exitStack()
  }

  @Test
  fun `content outside the stack counts against every screen`() {
    val after = budget()
    after.enterStack()
    after.enterScreen()
    assertNull(after.charge(6, 3))
    after.exitScreen()
    after.exitStack()
    assertNull(after.charge(4, 0))
    assertEquals(PrototypeScreenBudget.Overflow.NODES, after.charge(1, 0))
  }

  @Test
  fun `the whole spec stops at its own ceiling`() {
    val budget = budget()
    budget.enterStack()
    val results =
      List(3) {
        budget.enterScreen()
        budget.charge(10, 0).also { budget.exitScreen() }
      }
    assertEquals(listOf(null, null, PrototypeScreenBudget.Overflow.SPEC_NODES), results)
    assertEquals(
      "Expanded spec node limit exceeded",
      PrototypeScreenBudget.Overflow.SPEC_NODES.expandedMessage,
    )
  }

  @Test
  fun `validator budgets each stack screen against the shared contract`() {
    fun images(count: Int) =
      (0 until count).joinToString(",") { """{"type":"image","asset":"a$it"}""" }
    fun spec(root: String) =
      """{"id":"a","window":{"placement":{"type":"fullscreen"}},"root":$root}"""
    val stack =
      """{"type":"stack","id":"nav","start":"a","screens":{"a":{"type":"column","children":[${images(32)}]},"b":{"type":"column","children":[${images(32)}]}}}"""
    assertEquals(
      PrototypeSpecValidation.Success::class,
      PrototypeSpecValidator.validate(spec(stack))::class,
    )
    val around =
      """{"type":"column","children":[${images(2)},{"type":"stack","id":"nav","start":"a","screens":{"a":{"type":"column","children":[${images(31)}]}}}]}"""
    val failure = PrototypeSpecValidator.validate(spec(around)) as PrototypeSpecValidation.Failure
    assertEquals("root.children[2].screens[\"a\"].children[30]", failure.error.path)
    assertEquals("Image limit exceeded", failure.error.message)
  }
}
