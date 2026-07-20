package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

class DaemonJsonTest {
  @Test
  fun `encodes defaulted wire constants and omits optional nulls`() {
    val encoded = DaemonJson.encodeToString(DefaultedWireRequest(id = "request-1"))

    assertTrue(encoded.contains("\"type\":\"device_snapshot_request\""), encoded)
    assertFalse(encoded.contains("optional"), encoded)
  }

  @Test
  fun `preserves the existing JSON-RPC request payload`() {
    val encoded = DaemonJson.encodeToString(JsonRpcRequest(method = "tools/list"))

    assertFalse(encoded.contains("jsonrpc"), encoded)
    assertFalse(encoded.contains("id"), encoded)
    assertFalse(encoded.contains("params"), encoded)
  }

  @Test
  fun `uses the shared daemon wire configuration`() {
    assertTrue(DaemonJson.configuration.ignoreUnknownKeys)
    assertTrue(DaemonJson.configuration.encodeDefaults)
    assertFalse(DaemonJson.configuration.explicitNulls)
  }

  @Test
  fun `production daemon sources do not create ad hoc Json instances`() {
    val sourceDirectory = locateDaemonSourceDirectory()
    val factories =
      sourceDirectory
        .walkTopDown()
        .filter { it.isFile && it.extension == "kt" }
        .flatMap { source ->
          Regex("\\bJson\\s*(?:\\{|\\(|\\.Default\\b)").findAll(source.readText()).map {
            source.name
          }
        }
        .toList()

    assertEquals(
      listOf("DaemonJson.kt"),
      factories,
      "Daemon clients must use DaemonJson rather than construct Json directly (issue #4018).",
    )
  }

  private fun locateDaemonSourceDirectory(): File {
    val relative = "src/main/kotlin/dev/jasonpearson/automobile/desktop/core/daemon"
    return sequenceOf(
        File(relative),
        File("desktop-core/$relative"),
        File("android/desktop-core/$relative"),
      )
      .firstOrNull { it.isDirectory }
      ?: error("Could not locate daemon sources from user.dir=${System.getProperty("user.dir")}")
  }
}

@Serializable
private data class DefaultedWireRequest(
  val id: String,
  val type: String = "device_snapshot_request",
  val optional: String? = null,
)
