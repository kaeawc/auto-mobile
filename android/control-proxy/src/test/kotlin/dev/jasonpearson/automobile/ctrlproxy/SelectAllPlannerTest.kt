package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Test

// These inputs model accessibility node states; framework behavior needs device confirmation.
class SelectAllPlannerTest {
  @Test
  fun `hint showing needs no action and succeeds as empty text`() {
    assertEquals(SelectAllPlan(0, false), planSelectAll(5, true, -1, -1))
  }

  @Test
  fun `fully selected text needs no action`() {
    assertEquals(SelectAllPlan(5, false), planSelectAll(5, false, 0, 5))
  }

  @Test
  fun `empty text needs no action even with unknown selection`() {
    assertEquals(SelectAllPlan(0, false), planSelectAll(0, false, -1, -1))
  }

  @Test
  fun `partial selection requires action and true result succeeds`() {
    assertEquals(SelectAllPlan(5, true), planSelectAll(5, false, 1, 4))
    assertEquals(SelectAllOutcome(true, null), selectAllOutcome(5, true, false, 1, 4))
  }

  @Test
  fun `unknown selection requires action`() {
    assertEquals(SelectAllPlan(5, true), planSelectAll(5, false, -1, -1))
  }

  @Test
  fun `false action with unchanged partial selection retains failure`() {
    assertEquals(
      SelectAllOutcome(false, "performAction returned false"),
      selectAllOutcome(5, false, true, 1, 4),
    )
  }

  @Test
  fun `false action with refreshed full selection succeeds`() {
    assertEquals(SelectAllOutcome(true, null), selectAllOutcome(5, false, true, 0, 5))
  }

  @Test
  fun `failed refresh cannot confirm full selection`() {
    assertEquals(
      SelectAllOutcome(false, "performAction returned false"),
      selectAllOutcome(5, false, false, 0, 5),
    )
  }

  @Test
  fun `false action with unknown selection retains failure`() {
    assertEquals(
      SelectAllOutcome(false, "performAction returned false"),
      selectAllOutcome(5, false, true, -1, -1),
    )
  }

  @Test
  fun `only exact forward full range avoids action or recovers false result`() {
    for ((start, end) in listOf(0 to 4, 1 to 5, 5 to 0, 0 to 6, -1 to 5, 0 to -1)) {
      assertEquals(SelectAllPlan(5, true), planSelectAll(5, false, start, end))
      assertEquals(
        SelectAllOutcome(false, "performAction returned false"),
        selectAllOutcome(5, false, true, start, end),
      )
    }
  }
}
