package dev.jasonpearson.automobile.desktop.core.shell

import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.extension
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Pins which `shell/` components are actually reachable from the app (issue #4017).
 *
 * `AutoMobileContentDecompositionTest` only proves a component was *extracted*; this proves it is
 * *in use*. Roots are every main source file outside `shell/` in desktop-core, desktop-app and the
 * IDE plugin. A `shell/` declaration is reachable when a root, or the body of another reachable
 * declaration, names it. Reachability is followed per top-level declaration, so a dormant chain
 * (one dormant component calling another) stays dormant.
 *
 * [knownDormant] must match exactly: wiring a component in fails until it leaves the list, and a
 * new zero-caller component fails until someone decides to wire it, delete it, or list it here.
 */
class ShellReachabilityTest {
  private val moduleRoot = Path.of("")
  private val shellDir =
    moduleRoot.resolve("src/main/kotlin/dev/jasonpearson/automobile/desktop/core/shell")
  private val rootSourceDirs =
    listOf(
      moduleRoot.resolve("src/main/kotlin"),
      moduleRoot.resolve("../desktop-app/src/main/kotlin"),
      moduleRoot.resolve("../ide-plugin/src/main/kotlin"),
    )

  /** Zero-caller `shell/` components awaiting a wire-or-delete decision (issue #4017). */
  private val knownDormant =
    setOf(
      "CenterTabStrip",
    )

  private val declarations by lazy { shellDeclarations() }
  private val reachable by lazy { reachableNames(declarations, rootIdentifiers()) }

  @Test
  fun `dormant shell components are exactly the known set`() {
    val dormantComponents =
      declarations
        .filter { it.isComponent && it.visibility != Visibility.Private }
        .map { it.name }
        .filterNot { it in reachable }
        .toSet()

    assertEquals(
      knownDormant.sorted(),
      dormantComponents.sorted(),
      "shell/ components with no path from the app changed. Wire or delete newly dormant " +
        "components; drop newly wired ones from knownDormant.",
    )
  }

  @Test
  fun `shell components rewired by issue 4017 are reachable`() {
    listOf("ThreePaneShell", "PaneToggleToolbar", "MacOSTitleBarSpacer", "LeftSidebarPanel")
      .forEach { assertTrue(it in reachable, "$it should be reachable from the app") }
  }

  @Test
  fun `segmenter follows chains per declaration rather than per file`() {
    val source =
      """
      package x

      @Composable
      fun Wired() {
        Helper()
      }

      @Composable
      private fun Helper() {}

      @Composable
      fun Dormant() {
        Helper()
        Wired()
      }

      object Theme {
        val x = 1
      }
      """
        .trimIndent()
    val parsed = parseDeclarations(Path.of("Fake.kt"), source)
    assertEquals(listOf("Wired", "Helper", "Dormant", "Theme"), parsed.map { it.name })
    assertEquals(setOf("Wired", "Helper"), reachableNames(parsed, setOf("Wired")))
    assertEquals(listOf(true, true, true, true), parsed.map { it.isComponent })
  }

  @Test
  fun `an import alone does not make a component reachable`() {
    val parsed = parseDeclarations(Path.of("Fake.kt"), "@Composable\nfun Shell() {}")
    val importOnly = rootIdentifiersOf("package app\n\nimport x.Shell\n\nfun Main() {}")
    assertEquals(emptySet(), reachableNames(parsed, importOnly))
    val called = rootIdentifiersOf("import x.Shell\n\nfun Main() { Shell() }")
    assertEquals(setOf("Shell"), reachableNames(parsed, called))
  }

  private enum class Visibility {
    Public,
    Internal,
    Private,
  }

  private data class Declaration(
    val name: String,
    val file: Path,
    val visibility: Visibility,
    val isComponent: Boolean,
    val identifiers: Set<String>,
  )

  private fun shellDeclarations(): List<Declaration> {
    assertTrue(Files.isDirectory(shellDir), "$shellDir should exist (run from the module dir)")
    return Files.list(shellDir).use { files ->
      files
        .filter { it.extension == "kt" }
        .sorted()
        .toList()
        .flatMap { parseDeclarations(it, stripNonCode(it.readText())) }
    }
  }

  private fun rootIdentifiers(): Set<String> =
    rootSourceDirs
      .filter { Files.isDirectory(it) }
      .flatMap { dir ->
        Files.walk(dir).use { paths ->
          paths
            .filter { it.isRegularFile() && it.extension == "kt" }
            .filter { it.toAbsolutePath().normalize().parent != shellDirAbsolute() }
            .toList()
        }
      }
      .flatMapTo(mutableSetOf()) { rootIdentifiersOf(it.readText()) }

  private fun shellDirAbsolute(): Path = shellDir.toAbsolutePath().normalize()

  private fun reachableNames(
    candidates: List<Declaration>,
    rootIdentifiers: Set<String>,
  ): Set<String> {
    val visited = mutableSetOf<Declaration>()
    val frontier = ArrayDeque(candidates.filter { it.name in rootIdentifiers })
    while (frontier.isNotEmpty()) {
      val next = frontier.removeFirst()
      if (!visited.add(next)) continue
      candidates
        .filter { it !in visited && it != next && it.name in next.identifiers }
        .filter { it.visibility != Visibility.Private || it.file == next.file }
        .forEach(frontier::addLast)
    }
    return visited.map { it.name }.toSet()
  }

  private fun rootIdentifiersOf(source: String): Set<String> = stripNonCode(source).identifiers()

  private fun String.identifiers(): Set<String> =
    IDENTIFIER.findAll(this).mapTo(mutableSetOf()) { it.value }

  private fun parseDeclarations(file: Path, source: String): List<Declaration> {
    val lines = source.lines()
    val starts = lines.indices.filter { lines[it].startsWithTopLevelDeclarationOrAnnotation() }
    return starts.mapIndexedNotNull { index, start ->
      val end = starts.getOrNull(index + 1) ?: lines.size
      val segment = lines.subList(start, end).joinToString("\n")
      val header = lines[start]
      val match = DECLARATION.find(header) ?: return@mapIndexedNotNull null
      val annotations = annotationBlockAbove(lines, start)
      Declaration(
        name = match.groupValues[NAME_GROUP],
        file = file,
        visibility =
          when {
            header.contains("private ") -> Visibility.Private
            header.contains("internal ") -> Visibility.Internal
            else -> Visibility.Public
          },
        isComponent =
          annotations.contains("@Composable") || match.groupValues[KIND_GROUP] == "object",
        identifiers = segment.substringAfter(match.value).identifiers(),
      )
    }
  }

  private fun annotationBlockAbove(lines: List<String>, start: Int): String =
    lines.subList(0, start).takeLastWhile { it.startsWith("@") }.joinToString("\n")

  private fun String.startsWithTopLevelDeclarationOrAnnotation(): Boolean =
    DECLARATION.containsMatchIn(this) || (startsWith("@") && DECLARATION.find(this) == null)

  /** Drops comments and package/import directives: only a use, not an import, is a reference. */
  private fun stripNonCode(source: String): String =
    source
      .replace(Regex("(?m)^\\s*(?:package|import)\\s.*$"), "")
      .replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")
      .replace(Regex("(?m)^\\s*//.*$"), "")

  private companion object {
    const val KIND_GROUP = 1
    const val NAME_GROUP = 2
    val IDENTIFIER = Regex("[A-Za-z_][A-Za-z0-9_]*")
    val DECLARATION =
      Regex(
        "^(?:(?:public|internal|private|data|enum|sealed|abstract|open|inline|const|value)\\s+)*" +
          "(fun|val|var|class|object|interface|typealias)\\s+" +
          "(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?(\\w+)",
      )
  }
}
