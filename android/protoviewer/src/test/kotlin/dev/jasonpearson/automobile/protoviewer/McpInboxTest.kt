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
  private val inbox =
    McpInbox(
      root,
      { bytes, source, label ->
        imports += Triple(bytes, source, label)
        importResult
      },
      repository,
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
      listOf("mcp-6" to "   ", "mcp-7" to "x".repeat(121), "mcp-8" to "two\nlines")) {
      bundle(request)
      inbox.handle(McpCommand.Import(request, label))
      assertEquals("label", result(request).text("path"))
    }
    assertTrue(imports.isEmpty())
  }

  @Test
  fun openReportsAKnownEntryAndReturnsItForTheViewer() {
    repository.prototypes[FIRST] = Fixtures.prototype(FIRST)

    assertEquals(FIRST, inbox.handle(McpCommand.Open("mcp-9", FIRST)))

    val written = result("mcp-9")
    assertEquals("opened", written.text("status"))
    assertEquals(FIRST, written.text("libraryId"))
    assertEquals("Example $FIRST", written.text("label"))
  }

  @Test
  fun openOfAnUnknownOrMalformedIdIsNotFound() {
    assertNull(inbox.handle(McpCommand.Open("mcp-10", SECOND)))
    assertEquals("not_found", result("mcp-10").text("status"))
    assertNull(inbox.handle(McpCommand.Open("mcp-11", "../escape")))
    assertEquals("not_found", result("mcp-11").text("status"))
  }

  @Test
  fun parseAcceptsOnlyTheTwoActionsAndSafeRequestIds() {
    assertEquals(
      McpCommand.Import("mcp-1", "L"),
      McpCommand.parse(MCP_IMPORT_ACTION, "mcp-1", "L", null),
    )
    assertEquals(
      McpCommand.Open("mcp-1", FIRST),
      McpCommand.parse(MCP_OPEN_ACTION, "mcp-1", null, FIRST),
    )
    assertNull(McpCommand.parse("android.intent.action.VIEW", "mcp-1", null, null))
    assertNull(McpCommand.parse(MCP_IMPORT_ACTION, "../mcp-1", null, null))
    assertNull(McpCommand.parse(MCP_IMPORT_ACTION, null, null, null))
    assertNull(McpCommand.parse(MCP_OPEN_ACTION, "mcp-1", null, null))
  }
}
