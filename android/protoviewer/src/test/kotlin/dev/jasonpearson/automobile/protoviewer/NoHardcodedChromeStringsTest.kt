package dev.jasonpearson.automobile.protoviewer

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A deliberately small lint guard, not a Kotlin parser. Prototype specs are outside this module.
 * Compose text is invisible to Android Lint's HardcodedText, so this stands in for it.
 */
class NoHardcodedChromeStringsTest {
  @Test
  fun chromeUsesStringResources() {
    val violations = violations { line ->
      val exempt = EXEMPT.any { line.contains(it.key) }
      // Bundle keys are technical state identifiers, not Activity resource lookups.
      val bundleKey = line.contains("savedInstanceState?.getString(")
      CHROME_LITERAL.containsMatchIn(line) && !exempt && !bundleKey
    }
    assertTrue(violations.joinToString("\n"), violations.isEmpty())
  }

  @Test
  fun importRejectionReasonsAreNamedTokensWithAMessage() {
    // A raw literal or resolved string would bypass the mapping; use an IMPORT_REASON_* token that
    // importRejectionReason maps to a string resource.
    val violations = violations { REJECTION_LITERAL.containsMatchIn(it) }
    assertTrue(violations.joinToString("\n"), violations.isEmpty())
  }

  @Test
  fun chromeUsesLayoutDirectionRelativeApis() {
    val violations = violations { ABSOLUTE_DIRECTION.containsMatchIn(it) }
    assertTrue(violations.joinToString("\n"), violations.isEmpty())
  }

  @Test
  fun patternsCatchTheShapesTheyGuard() {
    assertTrue(CHROME_LITERAL.containsMatchIn("""Text("Hello")"""))
    assertTrue(CHROME_LITERAL.containsMatchIn("""contentDescription = "Close""""))
    assertTrue(
      CHROME_LITERAL.containsMatchIn("""Text(items.joinToString("\n") { "${'$'}{it.code}" })"""),
    )
    assertEquals(false, CHROME_LITERAL.containsMatchIn("""Text(stringResource(R.string.back))"""))
    assertTrue(REJECTION_LITERAL.containsMatchIn("""Rejected("uri", "Bad uri")"""))
    assertTrue(
      REJECTION_LITERAL.containsMatchIn("""Rejected("content", getString(R.string.import_x))"""),
    )
    assertEquals(
      false,
      REJECTION_LITERAL.containsMatchIn("""Rejected("uri", IMPORT_REASON_URI_REQUIRED)"""),
    )
    assertTrue(ABSOLUTE_DIRECTION.containsMatchIn("Modifier.absolutePadding(left = 4.dp)"))
    assertTrue(ABSOLUTE_DIRECTION.containsMatchIn("textAlign = TextAlign.Left"))
    assertEquals(false, ABSOLUTE_DIRECTION.containsMatchIn("Modifier.padding(start = 4.dp)"))
  }

  private fun violations(matches: (String) -> Boolean): List<String> {
    val sources = File(System.getProperty("user.dir"), "src/main/kotlin")
    assertTrue("Missing module sources: $sources", sources.isDirectory)
    return sources
      .walkTopDown()
      .filter { it.extension == "kt" }
      .flatMap { file ->
        file.readLines().mapIndexedNotNull { index, line ->
          if (matches(line)) "${file.name}:${index + 1}: $line" else null
        }
      }
      .toList()
  }

  private companion object {
    val CHROME_LITERAL =
      Regex(
        listOf(
            "\\bText\\s*\\(\\s*(?:text\\s*=\\s*)?\"",
            "\\bcontentDescription\\s*=\\s*\"",
            "\\bgetString\\s*\\(\\s*\"",
            // A lambda inside Text(...) that returns a raw literal, e.g. joinToString { "$a: $b" }.
            "\\bText\\s*\\(.*\\{\\s*\"",
          )
          .joinToString("|"),
      )
    // A resolved string as the reason would also bypass importRejectionReason's mapping.
    val REJECTION_LITERAL = Regex("\\bRejected\\s*\\([^,()]+,\\s*(?:\"|getString\\s*\\()")
    // Left/right APIs ignore RTL mirroring; use start/end and the relative Alignment/Arrangement.
    val ABSOLUTE_DIRECTION =
      Regex(
        "Alignment\\.(?:Top|Center|Bottom)?(?:Left|Right)\\b|AbsoluteAlignment|TextAlign\\." +
          "(?:Left|Right)\\b|Arrangement\\.Absolute|absolutePadding|absoluteOffset|Gravity\\." +
          "(?:LEFT|RIGHT)\\b",
      )
    val EXEMPT =
      mapOf("Text(\"⋮\"" to "Decorative menu glyph; parent button supplies its accessible name.")
  }
}
