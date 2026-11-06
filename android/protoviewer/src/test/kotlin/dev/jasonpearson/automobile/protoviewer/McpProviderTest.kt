package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class McpProviderTest {
  private lateinit var provider: McpProvider
  private lateinit var root: File
  private lateinit var authority: String

  @Before
  fun setUp() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    authority = "${context.packageName}.mcp"
    root = File(context.getExternalFilesDir(null), "mcp")
    root.deleteRecursively()
    provider = Robolectric.buildContentProvider(McpProvider::class.java).create().get()
  }

  @After
  fun tearDown() {
    root.deleteRecursively()
  }

  private fun uri(path: String): Uri = Uri.parse("content://$authority/$path")

  private fun read(path: String): String =
    ParcelFileDescriptor.AutoCloseInputStream(provider.openFile(uri(path), "r"))
      .bufferedReader()
      .use { it.readText() }

  @Test
  fun inboxWriteAndAppResultReadRoundTrip() {
    val inbox = uri("inbox/req-1.automobile-proto")
    ParcelFileDescriptor.AutoCloseOutputStream(provider.openFile(inbox, "w")).use {
      it.write("prototype".toByteArray())
    }
    assertEquals("prototype", File(root, "inbox/req-1.automobile-proto").readText())
    assertTrue(File(root, "results").isDirectory)
    // Results are written by McpInbox, never by the shell provider client.
    val result = """{"request":"req-1","status":"not_found"}"""
    File(root, "results/req-1.json").writeText(result)
    assertEquals(result, read("results/req-1.json"))
    ParcelFileDescriptor.AutoCloseOutputStream(provider.openFile(inbox, "wt")).use {
      it.write("new".toByteArray())
    }
    assertEquals("new", File(root, "inbox/req-1.automobile-proto").readText())
  }

  @Test
  fun missingResultReturnsAnEmptyStream() {
    assertEquals("", read("results/missing.json"))
  }

  @Test
  fun rejectsBadRequestIdsAndTraversal() {
    for (path in
      listOf(
        "results/bad.request.json",
        "results/${"a".repeat(65)}.json",
        "results/.json",
        "../results/req.json",
        "results/../req.json",
        "results/%2E%2E.json",
        "inbox/req/extra.automobile-proto",
        "results/req%2Fextra.json",
        "results//req.json",
        "results/req.json/",
      )) {
      assertThrows(IllegalArgumentException::class.java) { provider.openFile(uri(path), "r") }
      assertThrows(IllegalArgumentException::class.java) { provider.delete(uri(path), null, null) }
    }
  }

  @Test
  fun rejectsReadingInboxAndWritingResults() {
    assertThrows(IllegalArgumentException::class.java) {
      provider.openFile(uri("inbox/req.automobile-proto"), "r")
    }
    assertThrows(IllegalArgumentException::class.java) {
      provider.openFile(uri("results/req.json"), "w")
    }
  }

  @Test
  fun deletesOnlyTheRequestedInboxOrResult() {
    val inbox = uri("inbox/req.automobile-proto")
    provider.openFile(inbox, "w").close()
    val result = File(root, "results/req.json")
    result.writeText("{}")
    assertEquals(1, provider.delete(inbox, null, null))
    assertFalse(File(root, "inbox/req.automobile-proto").exists())
    assertTrue(result.exists())
    assertEquals(1, provider.delete(uri("results/req.json"), null, null))
    assertFalse(result.exists())
    assertEquals(0, provider.delete(uri("results/req.json"), null, null))
  }
}
