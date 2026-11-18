@file:OptIn(dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi::class)

package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.EmbeddedPrototypeHost
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class RuntimeAttachTargetTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private fun runtime(
    scope: kotlinx.coroutines.CoroutineScope,
    id: String = "panel",
    persistence: String? = null,
  ) =
    PrototypeRuntime(
      PrototypeSpec(
        id,
        PrototypeWindow(PrototypeFullscreenPlacement(), persistence = persistence),
        state = mapOf("title" to PrototypeScalar.Text("before")),
        root = PrototypeTextNode(text = "Title"),
      ),
      nextSequence = { 1L },
      clock = { 0L },
      requestScope = scope,
      warn = {},
    )

  private fun ops(value: String) =
    attachJson
      .parseToJsonElement(
        """[{"op":"replace","path":"/state/title","value":"$value"}]""",
      )
      .jsonArray

  @Test
  fun `runtime patch replies match CtrlProxy applied rejected and conflict fields`() = runTest {
    val target = RuntimeAttachTarget(EmbeddedPrototypeHost(backgroundScope, Mutex())) { false }
    val runtime = runtime(backgroundScope)
    target.runtime = runtime
    val rejected = target.patch("panel", null, ops("next"))
    assertFalse(rejected.success)
    assertEquals("baseRevision is required when a patch has /state ops", rejected.error)
    assertEquals(0L, rejected.revision)
    assertNull(rejected.conflict)
    val applied = target.patch("panel", 0, ops("next"))
    assertTrue("error=${applied.error}", applied.success)
    assertEquals(1L, applied.revision)
    assertEquals(1L, runtime.current.revision)
    assertNull(applied.error)
    assertEquals(PrototypeScalar.Text("next"), runtime.current.state["title"])
    val conflict = target.patch("panel", 0, ops("stale"))
    assertFalse(conflict.success)
    assertEquals("conflict: state changed after baseRevision 0", conflict.error)
    assertEquals(1L, conflict.revision)
    assertEquals(
      PrototypePatchConflict(1, mapOf("title" to PrototypeScalar.Text("next"))),
      conflict.conflict,
    )
    // Serialize the actual runtime reply, so discriminator and scalar shape are checked too.
    val frame = attachJson.encodeToJsonElement(WebSocketResponse.serializer(), conflict).jsonObject
    assertEquals(JsonPrimitive("prototype_result"), frame["type"])
    assertEquals(
      JsonPrimitive("next"),
      frame.getValue("conflict").jsonObject.getValue("state").jsonObject["title"],
    )
    runtime.close()
  }

  @Test
  fun `unknown inactive and replaced runtimes cannot be patched`() = runTest {
    val target = RuntimeAttachTarget(EmbeddedPrototypeHost(backgroundScope, Mutex())) { false }
    val old = runtime(backgroundScope)
    target.runtime = old
    val unknown = target.patch("other", 0, ops("next"))
    assertEquals("Unknown prototype id: other", unknown.error)
    assertNull(unknown.revision)
    assertEquals(0L, old.current.revision)
    val replacement = runtime(backgroundScope, "replacement")
    target.runtime = replacement
    assertFalse(target.patch("panel", 0, ops("next")).success)
    val applied = target.patch("replacement", 0, ops("next"))
    assertTrue("error=${applied.error}", applied.success)
    assertEquals(1L, applied.revision)
    assertEquals(1L, replacement.current.revision)
    assertEquals(PrototypeScalar.Text("next"), replacement.current.state["title"])
    assertEquals(0L, old.current.revision)
    assertEquals(PrototypeScalar.Text("before"), old.current.state["title"])
    replacement.close()
    assertFalse(target.patch("replacement", 1, ops("next")).success)
    old.close()
  }

  @Test
  fun `status follows the current runtime and sequence survives remount`() = runTest {
    val target = RuntimeAttachTarget(EmbeddedPrototypeHost(backgroundScope, Mutex())) { false }
    assertEquals(JsonPrimitive(false), target.status()["shown"])
    assertEquals(JsonNull, target.status()["id"])
    val first = runtime(backgroundScope)
    target.runtime = first
    target.nextSequence()
    val shown = target.status()
    assertEquals(JsonPrimitive(true), shown["shown"])
    assertEquals(JsonPrimitive("panel"), shown["id"])
    assertEquals(JsonPrimitive(false), shown["persistent"])
    assertEquals(JsonPrimitive("before"), shown.getValue("state").jsonObject["title"])
    assertEquals(JsonPrimitive(1L), shown["lastSequence"])
    assertTrue(shown.containsKey("pages"))
    assertTrue(shown.containsKey("appearance"))
    first.close()
    assertEquals(JsonPrimitive(false), target.status()["shown"])
    val next = runtime(backgroundScope, "replacement", persistence = "device")
    target.runtime = next
    assertEquals(2L, target.nextSequence())
    assertEquals(JsonPrimitive("replacement"), target.status()["id"])
    assertEquals(JsonPrimitive(true), target.status()["persistent"])
    next.close()
  }
}
