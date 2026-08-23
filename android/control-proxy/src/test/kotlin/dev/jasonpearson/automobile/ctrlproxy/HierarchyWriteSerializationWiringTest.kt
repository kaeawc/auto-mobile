package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Structural regression guard for issue #5469.
 *
 * CtrlProxy is an AccessibilityService and cannot be constructed in a fast unit test, so this test
 * scans the live source (masking literals/comments so braces inside strings do not fool the
 * matcher) to enforce the two acceptance criteria:
 * 1. A single `Changed` result serializes the tree at most once — the compact wire string is reused
 *    for the debug-file write rather than serialized a second time. The former pretty-printed
 *    `json` file serializer is retired entirely.
 * 2. A throttled `Changed` frame pays no disk write — `writeHierarchyToFile` for the event path
 *    lives inside the `shouldBroadcast()` branch, so a throttled frame skips it.
 */
class HierarchyWriteSerializationWiringTest {

  @Test
  fun `the changed-result handler writes the hierarchy file only when it broadcasts`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val changedBranch = changedBranchBody(source)

    val shouldBroadcastIdx = changedBranch.indexOf("broadcastThrottler.shouldBroadcast()")
    assertTrue(
      "the Changed branch must gate on broadcastThrottler.shouldBroadcast()",
      shouldBroadcastIdx >= 0,
    )

    val ifBraceOpen = changedBranch.indexOf('{', shouldBroadcastIdx)
    assertTrue("the shouldBroadcast() if-block must have a body", ifBraceOpen >= 0)
    val ifBraceClose = KotlinSourceScan.matchBrace(changedBranch, ifBraceOpen)
    val broadcastBlock = changedBranch.substring(ifBraceOpen, ifBraceClose)
    val elseBlock = changedBranch.substring(ifBraceClose)

    assertTrue(
      "the event-path disk write must live inside the shouldBroadcast() branch so a throttled " +
        "frame pays no flushed disk write (issue #5469)",
      "writeHierarchyToFile" in broadcastBlock,
    )
    assertTrue(
      "a throttled frame must not write the hierarchy file (issue #5469)",
      "writeHierarchyToFile" !in elseBlock,
    )
    assertEquals(
      "the Changed branch must call writeHierarchyToFile exactly once (only on the broadcast path)",
      1,
      Regex("writeHierarchyToFile").findAll(changedBranch).count(),
    )
  }

  @Test
  fun `a single changed result serializes the hierarchy at most once and reuses it`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val changedBranch = changedBranchBody(source)

    assertEquals(
      "a single Changed result must serialize the tree at most once (issue #5469)",
      1,
      Regex("""jsonCompact\.encodeToString""").findAll(changedBranch).count(),
    )
    assertTrue(
      "the Changed branch must reuse the single serialization for both the file and the wire " +
        "frame via the `serialized = ` parameter (issue #5469)",
      Regex("""writeHierarchyToFile\([^)]*serialized\s*=""").containsMatchIn(changedBranch) &&
        Regex("""broadcastHierarchyUpdate\([^)]*serialized\s*=""").containsMatchIn(changedBranch),
    )
  }

  @Test
  fun `the pretty-print json serializer used only for the hierarchy file is retired`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    // The former `private val json = Json { prettyPrint = true ... }` existed solely to serialize
    // the hierarchy file a second time. With one canonical (compact) serialization it is gone; the
    // remaining Json instances are jsonCompact and jsonLenient.
    assertTrue(
      "the redundant pretty-print `json` serializer must be removed (issue #5469)",
      !Regex("""\bval\s+json\s*=\s*Json\b""").containsMatchIn(source),
    )
    assertTrue(
      "the hierarchy file must be serialized with the canonical compact form",
      "jsonCompact.encodeToString" in writeHierarchyToFileBody(source),
    )
  }

  @Test
  fun `the hierarchy collector guards its body so one bad frame cannot kill the flow`() {
    // Regression guard (Codex on #5469): serialization was hoisted into the hierarchyFlow
    // collector,
    // out of writeHierarchyToFile/broadcastHierarchyUpdate's own try/catch. An encode failure on
    // one
    // frame must not complete the collector (it is launchIn'd once and never relaunched), so the
    // onEach body must be wrapped in try/catch.
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val flowStart = source.indexOf("hierarchyDebouncer.hierarchyFlow")
    assertTrue("hierarchyFlow collector not found in CtrlProxy.kt", flowStart >= 0)
    val onEachOpen = source.indexOf('{', source.indexOf(".onEach", flowStart))
    assertTrue("hierarchyFlow .onEach body not found", onEachOpen >= 0)
    val onEachBody = source.substring(onEachOpen, KotlinSourceScan.matchBrace(source, onEachOpen))

    val tryIdx = onEachBody.indexOf("try {")
    val whenIdx = onEachBody.indexOf("when (result)")
    assertTrue("the hierarchy collector body must open a try block", tryIdx in 0 until whenIdx)
    assertTrue(
      "the hierarchy collector must catch exceptions so one bad frame cannot complete the flow",
      Regex("""catch\s*\(\s*\w+\s*:\s*Exception\s*\)""").containsMatchIn(onEachBody),
    )
  }

  private fun changedBranchBody(source: String): String {
    val marker = "is HierarchyResult.Changed ->"
    val start = source.indexOf(marker)
    assertTrue("HierarchyResult.Changed branch not found in CtrlProxy.kt", start >= 0)
    val braceOpen = source.indexOf('{', start)
    assertTrue("Changed branch body not found", braceOpen >= 0)
    return source.substring(braceOpen, KotlinSourceScan.matchBrace(source, braceOpen))
  }

  private fun writeHierarchyToFileBody(source: String): String {
    val start = source.indexOf("private fun writeHierarchyToFile(")
    assertTrue("writeHierarchyToFile not found in CtrlProxy.kt", start >= 0)
    val braceOpen = source.indexOf('{', source.indexOf(')', start))
    assertTrue("writeHierarchyToFile body not found", braceOpen >= 0)
    return source.substring(braceOpen, KotlinSourceScan.matchBrace(source, braceOpen))
  }

  private fun readCtrlProxySource(): String = locateCtrlProxySource().readText()

  private fun locateCtrlProxySource(): File {
    val rel = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/CtrlProxy.kt"
    val direct =
      listOf(File(rel), File("control-proxy/$rel"), File("android/control-proxy/$rel"))
        .firstOrNull { it.isFile }
    if (direct != null) return direct

    var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (dir != null) {
      for (candidate in
        listOf(
          File(dir, rel),
          File(dir, "control-proxy/$rel"),
          File(dir, "android/control-proxy/$rel"),
        )) {
        if (candidate.isFile) return candidate
      }
      dir = dir.parentFile
    }
    fail("Could not locate CtrlProxy.kt from user.dir=${System.getProperty("user.dir")}")
    error("unreachable")
  }
}
