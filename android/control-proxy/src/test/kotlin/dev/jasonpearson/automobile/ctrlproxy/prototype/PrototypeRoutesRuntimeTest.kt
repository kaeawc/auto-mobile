package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import dev.jasonpearson.automobile.protocol.PrototypePopAction
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStackSnapshot
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/**
 * Navigation routes at runtime (#14188): per-entry params restored on pop, `{route.<name>}`
 * binding, onEnter after `screen_changed`, onBack interception versus `force`, setStack params and
 * the `stack:<id>` stored path. A fake store and timer stand in for the disk and the clock.
 */
class PrototypeRoutesRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }

    private const val FEED =
      """{"type":"column","children":[
        {"type":"text","text":"Feed"},
        {"type":"column","repeat":{"items":[{"id":"41"},{"id":"9"}],"as":"row"},"children":[
          {"type":"button","label":"Open {row.id}","onTap":[
            {"type":"push","stack":"nav","screen":"post","params":{"postId":{"item":"id"}}}]}]},
        {"type":"button","label":"Deep link","onTap":[
          {"type":"setStack","stack":"nav","path":[{"screen":"feed"},
            {"screen":"post","params":{"postId":"41"}},
            {"screen":"profile","params":{"userId":"ada"}}]}]},
        {"type":"button","label":"Bad state","onTap":[
          {"type":"push","stack":"nav","screen":"post","params":{"postId":{"state":"count"}}}]}]}"""

    private const val POST =
      """{"type":"column","children":[
        {"type":"text","text":"Post {route.postId}"},
        {"type":"text","text":"Pinned","visibleWhen":{"data":"/pins/{route.postId}","equals":true}},
        {"type":"button","label":"Author","onTap":[
          {"type":"push","stack":"nav","screen":"profile","params":{"userId":"u{route.postId}"}}]},
        {"type":"button","label":"Leave","onTap":[{"type":"pop","stack":"nav","force":true}]},
        {"type":"button","label":"Back","onTap":[{"type":"pop","stack":"nav"}]}]}"""

    private const val PROFILE =
      """{"type":"column","children":[
        {"type":"text","text":"User {route.userId}"},
        {"type":"button","label":"Post 7","onTap":[
          {"type":"push","stack":"nav","screen":"post","params":{"postId":"7"}}]}]}"""

    private const val ROUTES =
      """{"feed":{"onEnter":[{"type":"emit","name":"feed_entered"}]},
        "post":{"params":{"postId":"string"},
          "onEnter":[{"type":"emit","name":"entered_{route.postId}"}],
          "onBack":[{"type":"setState","key":"confirm","value":"{route.postId}"}]},
        "profile":{"params":{"userId":"string"}}}"""
  }

  private val store = FakePrototypeStorageStore()
  private val timer = FakePrototypeTimer()
  private val warnings = mutableListOf<String>()
  private val events = mutableListOf<PrototypeEvent>()
  private var sequence = 0L

  private fun spec(storage: Boolean = false, routes: String = ROUTES): PrototypeSpec {
    val storageField = if (storage) ""","storage":{"version":1,"keys":["stack:nav"]}""" else ""
    val input =
      """{"id":"routes","window":{"placement":{"type":"fullscreen"}},""" +
        """"state":{"confirm":"","count":3},"data":{"pins":{"41":true,"7":false}}$storageField,""" +
        """"root":{"type":"stack","id":"nav","start":"feed",""" +
        """"screens":{"feed":$FEED,"post":$POST,"profile":$PROFILE},"routes":$routes}}"""
    val validation = PrototypeSpecValidator.validate(input)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private fun runtime(
    spec: PrototypeSpec = spec(),
    storage: PrototypeStorageOpen? = null,
    previousStacks: Map<String, PrototypeStackSnapshot> = emptyMap(),
  ) =
    PrototypeRuntime(
      storage?.spec ?: spec,
      PrototypeEventSink { events += it },
      { 42L },
      { ++sequence },
      warn = { warnings += it },
      storage = storage?.session,
      previousStacks = previousStacks,
    )

  private fun persistence() =
    PrototypeStoragePersistence(
      store,
      timer,
      EmptyCoroutineContext,
      warn = PrototypeStorageWarn { message, _ -> warnings += message },
    )

  private fun PrototypeRuntime.texts(): List<String> {
    val found = mutableListOf<String>()
    fun visit(node: PrototypeRenderNode) {
      if (!node.visible) return
      if (node.role == "text") found += node.text
      node.children.forEach(::visit)
    }
    visit(renderModel().root)
    return found
  }

  private fun PrototypeRuntime.button(label: String): PrototypeInteraction.Tap {
    fun find(node: PrototypeRenderNode): PrototypeRenderNode? =
      if (node.role == "button" && node.text == label) node
      else node.children.firstNotNullOfOrNull(::find)
    val node = checkNotNull(find(renderModel().root)) { "No button $label" }
    return PrototypeInteraction.Tap(checkNotNull(node.source?.onTap))
  }

  private fun PrototypeRuntime.path() = current.stacks.getValue("nav").path

  private fun screenEvents() = events.filter { it.kind == PrototypeEventKind.SCREEN_CHANGED }

  private fun emitNames() = events.filter { it.kind == PrototypeEventKind.EMIT }.map { it.name }

  private fun params(json: String) = Json.parseToJsonElement(json).jsonObject

  @Test
  fun `each entry keeps its params, so Back shows the previous post again`() = runTest {
    val runtime = runtime()
    runtime.handle(runtime.button("Open 41"))
    assertTrue("Post 41" in runtime.texts())
    assertTrue("Pinned" in runtime.texts())
    runtime.handle(runtime.button("Author"))
    assertTrue("User u41" in runtime.texts())
    runtime.handle(runtime.button("Post 7"))
    assertTrue("Post 7" in runtime.texts())
    assertTrue("Pinned" !in runtime.texts())
    assertEquals(listOf("feed", "post", "profile", "post"), runtime.path())
    assertEquals(
      listOf(
        params("{}"),
        params("""{"postId":"41"}"""),
        params("""{"userId":"u41"}"""),
        params("""{"postId":"7"}"""),
      ),
      runtime.current.stacks.getValue("nav").params,
    )

    runtime.handle(runtime.button("Leave"))
    assertTrue("User u41" in runtime.texts())
    runtime.popTopmostStack()
    assertTrue("Post 41" in runtime.texts())
    assertEquals(listOf("feed", "post"), runtime.path())
    val last = screenEvents().last().payload!!.jsonObject
    assertEquals("post", last.getValue("screen").jsonPrimitive.content)
    assertEquals(params("""{"postId":"41"}"""), last.getValue("params"))
  }

  @Test
  fun `screen_changed carries params only when the top entry has them`() = runTest {
    val runtime = runtime()
    runtime.handle(runtime.button("Open 9"))
    runtime.handle(runtime.button("Leave"))
    val (pushed, popped) = screenEvents().map { it.payload!!.jsonObject }
    assertEquals(params("""{"screen":"post","depth":2,"params":{"postId":"9"}}"""), pushed)
    assertEquals(params("""{"screen":"feed","depth":1}"""), popped)
    assertNull(runtime.current.stacks.getValue("nav").params)
  }

  @Test
  fun `onEnter runs after screen_changed, with the entry's params bound`() = runTest {
    val runtime = runtime()
    runtime.shown()
    assertEquals(listOf("feed_entered"), emitNames())
    runtime.handle(runtime.button("Open 41"))
    val order = events.map { it.kind to it.name }
    assertEquals(
      listOf(
        PrototypeEventKind.EMIT to "feed_entered",
        PrototypeEventKind.SCREEN_CHANGED to "nav",
        PrototypeEventKind.EMIT to "entered_41",
      ),
      order,
    )
    runtime.handle(runtime.button("Leave"))
    assertEquals("feed_entered", emitNames().last())
  }

  @Test
  fun `onBack replaces Back and a plain pop, and force always pops`() = runTest {
    val runtime = runtime()
    runtime.handle(runtime.button("Open 41"))
    events.clear()

    assertTrue(runtime.popTopmostStack())
    assertEquals(listOf("feed", "post"), runtime.path())
    assertEquals(PrototypeScalar.Text("41"), runtime.current.state.getValue("confirm"))
    assertTrue(screenEvents().isEmpty())

    runtime.handle(runtime.button("Back"))
    assertEquals(listOf("feed", "post"), runtime.path())
    assertNull(runtime.backPreview())

    runtime.handle(PrototypeInteraction.Tap(listOf(PrototypePopAction("nav", force = true))))
    assertEquals(listOf("feed"), runtime.path())
  }

  @Test
  fun `setStack builds a back stack with params and reports parallel params`() = runTest {
    val runtime = runtime()
    runtime.handle(runtime.button("Deep link"))
    assertEquals(listOf("feed", "post", "profile"), runtime.path())
    assertTrue("User ada" in runtime.texts())
    assertEquals(1, screenEvents().size)
    val encoded =
      Json.encodeToJsonElement(
        PrototypeStackSnapshot.serializer(),
        runtime.current.stacks.getValue("nav"),
      )
    assertEquals(
      Json.parseToJsonElement(
        """{"path":["feed","post","profile"],"depth":3,"params":[{},{"postId":"41"},{"userId":"ada"}]}""",
      ),
      encoded,
    )
    runtime.handle(PrototypeInteraction.Tap(listOf(PrototypePopAction("nav", force = true))))
    assertTrue("Post 41" in runtime.texts())
  }

  @Test
  fun `params that resolve to the wrong type leave the stack unchanged`() = runTest {
    val runtime = runtime()
    runtime.handle(runtime.button("Bad state"))
    assertEquals(listOf("feed"), runtime.path())
    assertTrue(screenEvents().isEmpty())
    assertTrue(warnings.any { "route params do not fit" in it })
  }

  @Test
  fun `onEnter navigation cycles stop at the lifecycle nesting limit`() = runTest {
    val looping =
      """{"post":{"params":{"postId":"string"},"onEnter":[
          {"type":"push","stack":"nav","screen":"profile","params":{"userId":"x"}}]},
        "profile":{"params":{"userId":"string"},"onEnter":[
          {"type":"replace","stack":"nav","screen":"post","params":{"postId":"y"}}]}}"""
    val runtime = runtime(spec(routes = looping))
    runtime.handle(runtime.button("Open 41"))
    assertTrue(warnings.any { "lifecycle nesting limit" in it })
    assertTrue(runtime.path().size <= 32)
  }

  @Test
  fun `the path is stored with params and restored on the next show`() = runTest {
    val first = runtime(storage = persistence().open(spec(storage = true)))
    first.handle(first.button("Open 41"))
    first.handle(first.button("Author"))
    first.flushStorage()
    assertEquals(
      Json.parseToJsonElement(
        """[{"screen":"feed"},{"screen":"post","params":{"postId":"41"}},{"screen":"profile","params":{"userId":"u41"}}]""",
      ),
      store.stored("routes")?.values?.get("stack:nav"),
    )

    events.clear()
    val second = runtime(storage = persistence().open(spec(storage = true)))
    second.shown()
    assertEquals(listOf("feed", "post", "profile"), second.path())
    assertTrue("User u41" in second.texts())
    assertTrue(screenEvents().isEmpty())
    second.popTopmostStack()
    assertTrue("Post 41" in second.texts())
  }

  @Test
  fun `a stored path naming a stale screen or params starts the stack at start`() = runTest {
    for (stale in
      listOf(
        """[{"screen":"feed"},{"screen":"gone"}]""",
        """[{"screen":"feed"},{"screen":"post","params":{"postId":41}}]""",
        """[{"screen":"feed"},{"screen":"post"}]""",
      )) {
      store.seed(
        "routes",
        PrototypeStoredValues(1, mapOf("stack:nav" to Json.parseToJsonElement(stale))),
      )
      val runtime = runtime(storage = persistence().open(spec(storage = true)))
      runtime.shown()
      assertEquals(stale, listOf("feed"), runtime.path())
      runtime.flushStorage()
      assertEquals(
        JsonArray(listOf(JsonObject(mapOf("screen" to JsonPrimitive("feed"))))),
        store.stored("routes")?.values?.get("stack:nav"),
      )
    }
  }

  @Test
  fun `a preserving show skips onEnter only for the stacks it kept`() = runTest {
    runtime(previousStacks = mapOf("nav" to PrototypeStackSnapshot(listOf("feed"))))
      .shown(preservingState = true)
    assertTrue(emitNames().isEmpty())
    runtime(previousStacks = mapOf("other" to PrototypeStackSnapshot(listOf("feed"))))
      .shown(preservingState = true)
    assertEquals(listOf("feed_entered"), emitNames())
  }

  @Test
  fun `a stack that never navigated is not stored`() = runTest {
    val runtime = runtime(storage = persistence().open(spec(storage = true)))
    runtime.shown()
    runtime.flushStorage()
    assertNull(store.stored("routes")?.values?.get("stack:nav"))
  }
}
