package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Test

// These inputs model reported accessibility node states; they are unverified against a device.
class InsertTextPlannerTest {
  @Test
  fun `unreported selection in empty field inserts at zero`() {
    assertEquals(
      InsertTextPlan("abc", 3, true),
      planInsertText("", false, -1, -1, "abc"),
    )
  }

  @Test
  fun `hint text is excluded with unreported selection`() {
    assertEquals(
      InsertTextPlan("abc", 3, true),
      planInsertText("Email", true, -1, -1, "abc"),
    )
  }

  @Test
  fun `unreported selection in nonempty field appends`() {
    assertEquals(
      InsertTextPlan("before!", 7, true),
      planInsertText("before", false, -1, -1, "!"),
    )
  }

  @Test
  fun `valid collapsed selection inserts in middle`() {
    assertEquals(
      InsertTextPlan("abXcd", 3, false),
      planInsertText("abcd", false, 2, 2, "X"),
    )
  }

  @Test
  fun `valid range replaces selected text`() {
    assertEquals(
      InsertTextPlan("aXd", 2, false),
      planInsertText("abcd", false, 1, 3, "X"),
    )
  }

  @Test
  fun `reversed selection replaces selected text`() {
    assertEquals(
      InsertTextPlan("hXo", 2, false),
      planInsertText("hello", false, 4, 1, "X"),
    )
  }

  @Test
  fun `end beyond text length appends`() {
    assertEquals(
      InsertTextPlan("abcdX", 5, true),
      planInsertText("abcd", false, 1, 5, "X"),
    )
  }

  @Test
  fun `unreported start with valid end appends`() {
    assertEquals(
      InsertTextPlan("abcdX", 5, true),
      planInsertText("abcd", false, -1, 2, "X"),
    )
  }

  @Test
  fun `valid start with unreported end appends`() {
    assertEquals(
      InsertTextPlan("abcdX", 5, true),
      planInsertText("abcd", false, 2, -1, "X"),
    )
  }

  @Test
  fun `valid selection in hint field uses empty text`() {
    assertEquals(
      InsertTextPlan("X", 1, false),
      planInsertText("Email", true, 0, 0, "X"),
    )
  }

  @Test
  fun `caret counts full UTF16 length of inserted graphemes`() {
    val insertions =
      listOf(
        "\uD83D\uDC4D\uD83C\uDFFD",
        "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67",
        "\uD83C\uDDEF\uD83C\uDDF5",
        "\u00E9",
        "e\u0301",
      )

    for (insertion in insertions) {
      assertEquals(
        InsertTextPlan("a${insertion}b", 1 + insertion.length, false),
        planInsertText("ab", false, 1, 1, insertion),
      )
      assertEquals(
        InsertTextPlan("ab$insertion", 2 + insertion.length, true),
        planInsertText("ab", false, -1, -1, insertion),
      )
    }
  }
}
