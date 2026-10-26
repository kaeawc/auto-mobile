package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.junit.AfterClass
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** Pure controller boundaries: no Robolectric, Android context, renderer or GPU. */
class PrototypeShaderControllerTest {
  companion object {
    private data class Reply(val requestId: String?, val success: Boolean, val error: String?)

    private val replies = mutableListOf<Reply>()
    private val statuses = mutableListOf<List<PrototypeStatusEntry>>()
    private lateinit var assetStore: PrototypeAssetStore
    private lateinit var assets: PrototypeAssetController
    private lateinit var controller: PrototypeController
    private lateinit var runtime: PrototypeRuntime
    private val spec =
      PrototypeSpec(
        "panel",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root = PrototypeTextNode(text = "Shader status"),
      )

    @JvmStatic
    @BeforeClass
    fun fixtures() = runBlocking {
      replies.clear()
      statuses.clear()
      assetStore =
        PrototypeAssetStore(
          FakePrototypeAssetFiles(),
          shaderCompiler =
            PrototypeShaderCompiler {
              Result.failure(IllegalArgumentException("a".repeat(2045) + "😀"))
            },
        )
      assets =
        PrototypeAssetController(
          assetStore,
          PrototypeResultSink { id, success, error -> replies += Reply(id, success, error) },
          PrototypeBase64Decoder { Base64.getDecoder().decode(it) },
        )
      controller =
        PrototypeController(
          FakePrototypeHost(),
          object : PrototypeResultSink {
            override suspend fun send(requestId: String?, success: Boolean, error: String?) {
              check(success) { error.orEmpty() }
            }

            override suspend fun sendPrototypeStatus(
              requestId: String?,
              prototypes: List<PrototypeStatusEntry>,
              droppedEvents: Long,
            ) {
              statuses += prototypes
            }
          },
          clock = { 0L },
          lifecycle = PrototypeLifecycle(FakePrototypeTimer(), 500),
        )
      controller.show("fixture", spec)
      runtime = checkNotNull(controller.activeRuntime)
    }

    @JvmStatic @AfterClass fun close() = runBlocking { controller.destroy() }
  }

  @Test
  fun `compiler failure is one bounded correlated error reply and stores nothing`() = runBlocking {
    assets.put("shader-put", "effect", "application/vnd.automobile.agsl", "IA==")
    assertEquals(listOf(Reply("shader-put", false, "a".repeat(2045))), replies)
    assertEquals(0, assetStore.count)
  }

  @Test
  fun `inspect reports shader fallback and in-place show preserves it until reset`() = runBlocking {
    runtime.shaderSession.guard("root/node").disable("Shader draw failed: test failure")
    controller.inspect("inspect")
    assertEquals(
      mapOf("root/node" to "Shader draw failed: test failure"),
      statuses.last().single().shaderFailures,
    )
    controller.show("in-place", spec)
    assertSame(runtime.shaderSession, controller.activeRuntime?.shaderSession)
    controller.inspect("inspect")
    assertFalse(statuses.last().single().shaderFailures.isEmpty())
    controller.show("reset", spec, reset = true)
    controller.inspect("inspect")
    assertTrue(statuses.last().single().shaderFailures.isEmpty())
  }
}
