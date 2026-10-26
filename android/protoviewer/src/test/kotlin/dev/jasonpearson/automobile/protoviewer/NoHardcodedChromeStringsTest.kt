package dev.jasonpearson.automobile.protoviewer

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** A deliberately small lint guard, not a Kotlin parser. Prototype specs are outside this module. */
class NoHardcodedChromeStringsTest {
  @Test
  fun chromeUsesStringResources() {
    val sources = File(System.getProperty("user.dir"), "src/main/kotlin")
    assertTrue("Missing module sources: $sources", sources.isDirectory)
    val violations =
      sources.walkTopDown().filter { it.extension == "kt" }.flatMap { file ->
        file.readLines().mapIndexedNotNull { index, line ->
          val exempt = EXEMPT.any { line.contains(it.key) }
          val literal = CHROME_LITERAL.containsMatchIn(line)
          // Bundle keys are technical state identifiers, not Activity resource lookups.
          val bundleKey = line.contains("savedInstanceState?.getString(")
          if (literal && !exempt && !bundleKey) "${file.name}:${index + 1}: $line" else null
        }
      }.toList()
    assertTrue(violations.joinToString("\n"), violations.isEmpty())
  }

  private companion object {
    val CHROME_LITERAL = Regex(
      "\\bText\\s*\\(\\s*(?:text\\s*=\\s*)?\"|\\bcontentDescription\\s*=\\s*\"|\\bgetString\\s*\\(\\s*\"",
    )
    val EXEMPT = mapOf("Text(\"⋮\"" to "Decorative menu glyph; parent button supplies its accessible name.")
  }
}
