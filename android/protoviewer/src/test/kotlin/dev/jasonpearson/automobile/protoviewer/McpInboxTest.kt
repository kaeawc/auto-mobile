package dev.jasonpearson.automobile.protoviewer

import java.io.File
import java.nio.file.Files
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class McpInboxTest {
  private val root: File = Files.createTempDirectory("mcp-inbox").toFile()
  private val repository = FakeLibraryRepository()
  private val imports = mutableListOf<Triple<ByteArray, LibrarySource, String?>>()
  private var importResult: LibraryImportResult =
    LibraryImportResult.Imported(Fixtures.entry().copy(label = "Checkout"))
  private var nowMillis = 1_000_000_000L
  private val inbox =
    McpInbox(
      root,
      { bytes, source, label ->
        imports += Triple(bytes, source, label)
        importResult
      },
      repository,
      { nowMillis },
    )

  @After
  fun cleanUp() {
    root.deleteRecursively()
  }

  private fun bundle(request: String, bytes: ByteArray = SPEC.toByteArray()) =
    File(root, "inbox/$request.automobile-proto").apply {
      parentFile.mkdirs()
      writeBytes(bytes)
    }

  private fun result(request: String): JsonObject =
    Json.parseToJsonElement(File(root, "results/$request.json").readText()).jsonObject

  private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content

  @Test
  fun importCommitsWithTheMcpSourceAndCallerLabelThenReportsTheEntry() {
    val pushed = bundle("mcp-1")

    assertNull(inbox.handle(McpCommand.Import("mcp-1", "Checkout")))

    assertEquals(1, imports.size)
    assertEquals(SPEC, imports.single().first.decodeToString())
    assertEquals(LibrarySource.mcp, imports.single().second)
    assertEquals("Checkout", imports.single().third)
    assertFalse("the inbox copy is deleted after reading", pushed.exists())
    val written = result("mcp-1")
    assertEquals(
      mapOf(
        "status" to "imported",
        "request" to "mcp-1",
        "libraryId" to FIRST,
        "label" to "Checkout",
      ),
      written.mapValues { it.value.jsonPrimitive.content },
    )
    assertEquals(listOf("mcp-1.json"), File(root, "results").list()!!.toList())
  }

  @Test
  fun importWithoutLabelKeepsTheAppDefault() {
    bundle("mcp-2")
    inbox.handle(McpCommand.Import("mcp-2", null))
    assertNull(imports.single().third)
  }

  @Test
  fun aRejectedBundleIsReportedWithItsPath() {
    bundle("mcp-3")
    importResult = LibraryImportResult.Rejected("spec.json:/root/onTap", "via host is not allowed")

    inbox.handle(McpCommand.Import("mcp-3", null))

    val written = result("mcp-3")
    assertEquals("rejected", written.text("status"))
    assertEquals("spec.json:/root/onTap", written.text("path"))
    assertEquals("via host is not allowed", written.text("reason"))
  }

  @Test
  fun aMissingInboxFileIsRejectedWithoutImporting() {
    inbox.handle(McpCommand.Import("mcp-4", null))
    assertEquals("rejected", result("mcp-4").text("status"))
    assertEquals("inbox", result("mcp-4").text("path"))
    assertTrue(imports.isEmpty())
  }

  @Test
  fun anOversizedBareSpecIsRejectedAndStillDeleted() {
    val pushed = bundle("mcp-5", ByteArray(2 * 1024 * 1024) { '{'.code.toByte() })

    inbox.handle(McpCommand.Import("mcp-5", null))

    assertEquals("content", result("mcp-5").text("path"))
    assertFalse(pushed.exists())
    assertTrue(imports.isEmpty())
  }

  @Test
  fun anUnusableLabelIsRejectedBeforeImporting() {
    for ((request, label) in
      listOf(
        "mcp-6" to "   ",
        "mcp-7" to "x".repeat(121),
        "mcp-8" to "two\nlines",
        "mcp-16" to "evil\u202Eevil",
        "mcp-17" to "a\u2028b",
      )) {
      bundle(request)
      inbox.handle(McpCommand.Import(request, label))
      assertEquals("label", result(request).text("path"))
    }
    assertTrue(imports.isEmpty())
  }

  @Test
  fun openReturnsAKnownEntryAndReportsItOnlyAfterTheLaunch() {
    repository.prototypes[FIRST] = Fixtures.prototype(FIRST)
    val command = McpCommand.Open("mcp-9", FIRST)

    val entry = inbox.handle(command)

    assertEquals(FIRST, entry?.libraryId)
    assertFalse("nothing is reported before the launch", File(root, "results/mcp-9.json").exists())
    inbox.reportOpened(command, entry!!)
    val written = result("mcp-9")
    assertEquals("opened", written.text("status"))
    assertEquals(FIRST, written.text("libraryId"))
    assertEquals("Example $FIRST", written.text("label"))
  }

  @Test
  fun aFailedLaunchIsReportedAsRejected() {
    inbox.reportOpenFailed(McpCommand.Open("mcp-12", FIRST))
    assertEquals("viewer", result("mcp-12").text("path"))
  }

  @Test
  fun openOfAnUnknownOrMalformedIdIsNotFound() {
    assertNull(inbox.handle(McpCommand.Open("mcp-10", SECOND)))
    assertEquals("not_found", result("mcp-10").text("status"))
    assertNull(inbox.handle(McpCommand.Open("mcp-11", "../escape")))
    assertEquals("not_found", result("mcp-11").text("status"))
  }

  @Test
  fun anUnreadableLibraryIsNotReportedAsNotFound() {
    repository.error = LibraryError.Storage
    assertNull(inbox.handle(McpCommand.Open("mcp-13", FIRST)))
    assertEquals("library", result("mcp-13").text("path"))
  }

  @Test
  fun aSpecNeedingANewerProtoViewerIsReportedAsACapability() {
    bundle("mcp-14")
    importResult = LibraryImportResult.Rejected("spec.json", UNSUPPORTED_PROTOTYPE_REASON)
    inbox.handle(McpCommand.Import("mcp-14", null))
    assertEquals("capability", result("mcp-14").text("path"))
  }

  @Test
  fun anActionThisBuildCannotRunIsAnsweredInsteadOfLeftWaiting() {
    val command = McpCommand.parse("${MCP_IMPORT_ACTION}_V2", "mcp-15", null, null)
    assertNull(inbox.handle(command!!))
    assertEquals("action", result("mcp-15").text("path"))
  }

  @Test
  fun prepareCreatesTheInboxAndResultsFoldersAndReportsThem() {
    val fresh = Files.createTempDirectory("mcp-fresh").toFile()
    try {
      val mcp = File(fresh, "mcp")
      val freshInbox = McpInbox(mcp, { _, _, _ -> importResult }, repository)

      assertNull(freshInbox.handle(McpCommand.Prepare("mcp-18")))

      assertTrue(File(mcp, "inbox").isDirectory)
      assertTrue(File(mcp, "results").isDirectory)
      val written = Json.parseToJsonElement(File(mcp, "results/mcp-18.json").readText()).jsonObject
      assertEquals("prepared", written.text("status"))
      assertEquals("mcp-18", written.text("request"))
      // A second prepare, or a concurrent request, finds the folders and is still answered.
      assertNull(freshInbox.handle(McpCommand.Prepare("mcp-19")))
      assertTrue(File(mcp, "results/mcp-19.json").isFile)
    } finally {
      fresh.deleteRecursively()
    }
  }

  @Test
  fun aFolderTheAppCannotCreateIsReportedNotPretendedReady() {
    // A file where the inbox folder belongs stands in for a folder owned by someone else.
    File(root, "inbox").writeText("not a directory")

    assertFalse(inbox.ensureDirectories())
    assertNull(inbox.handle(McpCommand.Prepare("mcp-20")))

    assertEquals("rejected", result("mcp-20").text("status"))
    assertEquals("storage", result("mcp-20").text("path"))
  }

  @Test
  fun parseNeedsASafeRequestIdAndAnswersEveryOtherLaunch() {
    assertEquals(
      McpCommand.Import("mcp-1", "L"),
      McpCommand.parse(MCP_IMPORT_ACTION, "mcp-1", "L", null),
    )
    assertEquals(
      McpCommand.Open("mcp-1", FIRST),
      McpCommand.parse(MCP_OPEN_ACTION, "mcp-1", null, FIRST),
    )
    assertEquals(
      McpCommand.Prepare("mcp-1"),
      McpCommand.parse(MCP_PREPARE_ACTION, "mcp-1", null, null),
    )
    assertTrue(
      McpCommand.parse("android.intent.action.VIEW", "mcp-1", null, null) is McpCommand.Unsupported,
    )
    assertTrue(McpCommand.parse(MCP_OPEN_ACTION, "mcp-1", null, null) is McpCommand.Unsupported)
    assertNull(McpCommand.parse(MCP_IMPORT_ACTION, "../mcp-1", null, null))
    assertNull(McpCommand.parse(MCP_IMPORT_ACTION, null, null, null))
  }

  private fun aged(file: File, ageMs: Long) = file.apply { setLastModified(nowMillis - ageMs) }

  private fun staged(path: String, ageMs: Long) =
    aged(File(root, path).apply { parentFile.mkdirs() }.apply { writeText("x") }, ageMs)

  @Test
  fun sweepRemovesOldResultsAndInboxBundlesButKeepsFreshOnes() {
    val oldResult = staged("results/old.json", MCP_ORPHAN_MAX_AGE_MS + 60_000)
    val oldTemp = staged("results/.old.json.tmp", MCP_ORPHAN_MAX_AGE_MS + 60_000)
    val oldBundle = staged("inbox/stray.automobile-proto", MCP_ORPHAN_MAX_AGE_MS + 60_000)
    val freshResult = staged("results/fresh.json", MCP_ORPHAN_MAX_AGE_MS - 60_000)
    val freshBundle = staged("inbox/inflight.automobile-proto", 0)

    assertEquals(3, inbox.sweepOrphans())

    assertFalse(oldResult.exists())
    assertFalse(oldTemp.exists())
    assertFalse(oldBundle.exists())
    assertTrue(freshResult.exists())
    assertTrue(freshBundle.exists())
  }

  @Test
  fun sweepKeepsDirectoriesAndIsANoOpBeforeTheFoldersExist() {
    assertEquals(0, inbox.sweepOrphans())
    val nested = File(root, "results/nested").apply { mkdirs() }
    aged(nested, MCP_ORPHAN_MAX_AGE_MS * 2)

    assertEquals(0, inbox.sweepOrphans())
    assertTrue(nested.isDirectory)
  }

  @Test
  fun handlingACommandSweepsOrphansButNotItsOwnFreshBundleOrResult() {
    val stale = staged("results/gone.json", MCP_ORPHAN_MAX_AGE_MS * 2)
    bundle("mcp-9")

    inbox.handle(McpCommand.Import("mcp-9", null))

    assertFalse(stale.exists())
    assertEquals("imported", result("mcp-9").text("status"))
  }
}
