package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeDataBindingTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val json = Json { classDiscriminator = "type" }

  private fun fixtures(): File =
    generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
      .map { File(it, "test/fixtures/prototype-spec") }
      .first { it.isDirectory }

  private fun validated(input: String): PrototypeSpec {
    val validation = PrototypeSpecValidator.validate(input)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private fun orders(): PrototypeSpec =
    validated(File(fixtures(), "valid/data-repeat-path.json").readText())

  private fun runtime(spec: PrototypeSpec) =
    PrototypeRuntime(spec, clock = { 42L }, nextSequence = { 0L })

  @Test
  fun `path repeat renders the equivalent literal model`() {
    val spec = orders()
    // Decode the expected in-memory constant condition; never send it through the validator.
    val literalRoot =
      json.decodeFromString<PrototypeNode>(
        """{
          "type":"column",
          "repeat":{"items":[{"id":7,"title":"Latte","total":4.5}],"as":"item","key":"id"},
          "children":[{"type":"text","text":"{item.title} 1",
            "visibleWhen":{"all":[]},"onTap":[{"type":"toggle","key":"liked_{item.id}"}]}]
        }""",
      )
    val actual = runtime(spec).renderModel()
    assertEquals(mapPrototypeSpec(spec.copy(root = literalRoot, data = null)), actual)
    assertEquals("Latte 1", actual.root.children.single().text)
    assertTrue(actual.root.children.single().visible)
  }

  @Test
  fun `every shared resolve fixture renders its expected root`() {
    val files =
      checkNotNull(File(fixtures(), "data/resolve").listFiles())
        .filter { it.extension == "json" }
        .sortedBy { it.name }
    assertTrue(files.isNotEmpty())
    for (file in files) {
      val fixture = json.parseToJsonElement(file.readText()).jsonObject
      val spec = validated(fixture.getValue("spec").toString())
      val root = json.decodeFromJsonElement<PrototypeNode>(fixture.getValue("root"))
      assertEquals(
        file.name,
        // The fixture root is already resolved; inserted data text must not be scanned again.
        prototypeRenderModel(
          spec,
          PrototypeNodeMapping(
              spec.state.orEmpty(),
              emptyMap(),
              fullscreenRoot = spec.window.placement is PrototypeFullscreenPlacement,
            )
            .map(root, "root"),
        ),
        runtime(spec).renderModel(),
      )
    }
  }

  @Test
  fun `state writes validate authored bindings and reuse one resolved root and mapping`() =
    runTest {
      val spec = orders()
      val runtime = runtime(spec)
      var preparations = 0
      runtime.prepareStateWrites = { authored ->
        preparations++
        assertSame(spec.root, authored.root)
        assertSame(spec.data, authored.data)
        assertEquals("/orders", (authored.root as PrototypeColumnNode).repeat?.itemsPath)
        PrototypeSpecValidator.prepareStateWrites(authored, json)
      }
      val before = runtime.renderModel()
      val mapper = PrototypeRenderMapper()
      mapper.map(runtime.current.spec, runtime.current.pages)
      val resolvedSpec = checkNotNull(mapper.lastResolvedSpec)
      val resolvedRoot = resolvedSpec.root
      assertSame(before, runtime.renderModel())
      mapper.map(runtime.current.spec, runtime.current.pages)
      assertSame(resolvedSpec, mapper.lastResolvedSpec)
      assertEquals(1, mapper.mappingPasses)
      val root = before.root.source
      assertEquals(1, runtime.renderMappingPasses)
      val actions = checkNotNull(before.root.children.single().source?.onTap)
      runtime.handle(PrototypeInteraction.Tap(actions))
      assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["liked_7"])
      assertEquals(1, preparations)
      assertSame(spec.data, runtime.current.spec.data)
      assertSame(spec.root, runtime.current.spec.root)
      assertEquals("/orders", (runtime.current.spec.root as PrototypeColumnNode).repeat?.itemsPath)
      // A resolver run decodes a fresh root: identity pins that it did not run again on the write.
      val after = runtime.renderModel()
      assertSame(root, after.root.source)
      // Check the cache itself too: model interning can hide an unnecessary resolver run.
      mapper.map(runtime.current.spec, runtime.current.pages)
      assertSame(resolvedRoot, checkNotNull(mapper.lastResolvedSpec).root)
      assertEquals(2, mapper.mappingPasses)
      assertEquals(2, runtime.renderMappingPasses)
      assertSame(after, runtime.renderModel())
      assertEquals(2, runtime.renderMappingPasses)
    }

  @Test
  fun `unbound specs pass through unchanged with and without data`() {
    val mapper = PrototypeRenderMapper()
    val plain =
      PrototypeSpec(
        "plain",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root = PrototypeTextNode(text = "literal"),
      )
    for (spec in listOf(plain, plain.copy(data = buildJsonObject { put("unused", 1) }))) {
      mapper.map(spec, emptyMap())
      assertSame(spec, mapper.lastResolvedSpec)
      mapper.map(spec, emptyMap())
      assertSame(spec, mapper.lastResolvedSpec)
      val written = spec.copy(state = mapOf("unused" to PrototypeScalar.BooleanValue(true)))
      mapper.map(written, emptyMap())
      assertSame(written, mapper.lastResolvedSpec)
      val runtime = runtime(spec)
      val model = runtime.renderModel()
      assertSame(spec.root, model.root.source)
      assertSame(model, runtime.renderModel())
      assertEquals(1, runtime.renderMappingPasses)
    }
  }

  @Test
  fun `cache follows root and data identity rather than structural equality`() {
    val mapper = PrototypeRenderMapper()
    val spec = orders()
    mapper.map(spec, emptyMap())
    val first = checkNotNull(mapper.lastResolvedSpec)
    val newData = JsonObject(checkNotNull(spec.data).toMap())
    mapper.map(spec.copy(data = newData), emptyMap())
    assertNotSame(first.root, checkNotNull(mapper.lastResolvedSpec).root)
    val changed = spec.copy(data = JsonObject(newData + ("cartCount" to JsonPrimitive(0))))
    val model = mapper.map(changed, emptyMap())
    assertEquals("Latte 0", model.root.children.single().text)
    assertFalse(model.root.children.single().visible)
    val newRoot = (spec.root as PrototypeColumnNode).copy()
    mapper.map(spec.copy(root = newRoot), emptyMap())
    val next = checkNotNull(mapper.lastResolvedSpec)
    assertNotSame(model.root.source, next.root)
  }

  @Test
  fun `fresh mapping of authored data equals runtime rendering`() {
    val spec = orders()
    val runtime = runtime(spec)
    assertEquals(mapPrototypeSpec(spec), runtime.renderModel())
    assertSame(spec, runtime.current.spec)
  }

  @Test
  fun `runtime replacement resolves new data with the same authored root`() {
    val spec = orders()
    val runtime = runtime(spec)
    val before = runtime.renderModel()
    val changed =
      spec.copy(data = JsonObject(checkNotNull(spec.data) + ("cartCount" to JsonPrimitive(0))))
    assertSame(spec.root, changed.root)
    assertNotSame(spec.data, changed.data)
    runtime.replace(changed)
    val after = runtime.renderModel()
    assertNotSame(before.root.source, after.root.source)
    assertEquals("Latte 0", after.root.children.single().text)
    assertFalse(after.root.children.single().visible)
    assertEquals(mapPrototypeSpec(changed), after)
    assertSame(changed, runtime.current.spec)
    assertEquals(2, runtime.renderMappingPasses)
    assertSame(after, runtime.renderModel())
    assertEquals(2, runtime.renderMappingPasses)
  }

  private class RecordingSink : PrototypeResultSink {
    val replies = mutableListOf<Pair<Boolean, String?>>()
    var entries: List<PrototypeStatusEntry> = emptyList()

    override suspend fun send(requestId: String?, success: Boolean, error: String?) {
      replies += success to error
    }

    override suspend fun sendPrototypeStatus(
      requestId: String?,
      prototypes: List<PrototypeStatusEntry>,
      droppedEvents: Long,
    ) {
      entries = prototypes
    }
  }

  @Test
  fun `controller render and inspect use resolved content and authored data respectively`() =
    runTest {
      val host = FakePrototypeHost()
      val sink = RecordingSink()
      val models = mutableListOf<PrototypeRenderModel>()
      val controller =
        PrototypeController(
          host,
          sink,
          clock = { 42L },
          lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
          render = {
            if (it.data != null)
              assertEquals("/orders", (it.root as? PrototypeColumnNode)?.repeat?.itemsPath)
            mapPrototypeSpec(it).also { model -> models += model }.request()
          },
        )
      val spec = orders()
      controller.show("data", spec)
      assertEquals(true, sink.replies.last().first)
      assertEquals("Latte 1", models.last().root.children.single().text)
      val runtime = checkNotNull(controller.activeRuntime)
      assertEquals(models.last(), runtime.renderModel())
      assertEquals("/orders", (runtime.current.spec.root as PrototypeColumnNode).repeat?.itemsPath)
      controller.inspect("inspect-data")
      assertEquals(spec.data, sink.entries.single().data)
      assertTrue(json.encodeToJsonElement(sink.entries.single()).jsonObject.containsKey("data"))
      val plain = spec.copy(root = PrototypeTextNode(text = "plain"), data = null)
      controller.show("plain", plain)
      assertEquals(true, sink.replies.last().first)
      controller.inspect("inspect-plain")
      assertNull(sink.entries.single().data)
      assertFalse(json.encodeToJsonElement(sink.entries.single()).jsonObject.containsKey("data"))
    }

  @Test
  fun `controller validates data repeat expansion before resolution`() = runTest {
    val host = FakePrototypeHost()
    val sink = RecordingSink()
    val controller =
      PrototypeController(
        host,
        sink,
        clock = { 42L },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      )
    val spec = orders()
    val column = spec.root as PrototypeColumnNode
    val oversized =
      spec.copy(
        root =
          column.copy(
            children =
              List(PrototypeSpecValidator.MAX_PROTOTYPE_NODES / 2 + 1) {
                PrototypeSpacerNode()
              },
          ),
        data =
          JsonObject(
            checkNotNull(spec.data) +
              ("orders" to JsonArray(List(2) { buildJsonObject { put("id", it) } })),
          ),
      )
    // Pin the render guard independently of the controller's wire validation.
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        mapPrototypeSpec(oversized)
      }
    assertTrue(error.message.orEmpty().contains("Node limit exceeded"))
    // A resolver-first controller would report this resolved guard message instead.
    val resolvedError =
      assertThrows(IllegalArgumentException::class.java) {
        guardPrototypeTree(PrototypeDataResolver.resolve(oversized).root)
      }
    assertEquals("root.repeat[1].children[998]: Node limit exceeded", resolvedError.message)
    controller.show("too-many", oversized)
    assertEquals(false, sink.replies.last().first)
    assertEquals("root.repeat: Expanded node limit exceeded", sink.replies.last().second)
    assertTrue(host.calls.isEmpty())
    assertNull(controller.activeRuntime)
  }

  @Test
  fun `runtime replacement resolves a new template with the same data instance`() {
    val spec = orders()
    val runtime = runtime(spec)
    assertEquals("Latte 1", runtime.renderModel().root.children.single().text)
    val column = spec.root as PrototypeColumnNode
    val text = column.children.single() as PrototypeTextNode
    val changed =
      spec.copy(root = column.copy(children = listOf(text.copy(text = "New {item.title}"))))
    assertSame(spec.data, changed.data)
    runtime.replace(changed)
    val after = runtime.renderModel()
    assertEquals("New Latte", after.root.children.single().text)
    assertEquals(2, runtime.renderMappingPasses)
    assertSame(after, runtime.renderModel())
  }

  @Test
  fun `controller refuses more than 2000 authored containers with and without data`() = runTest {
    val host = FakePrototypeHost()
    val sink = RecordingSink()
    val controller =
      PrototypeController(
        host,
        sink,
        clock = { 42L },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      )
    val root =
      PrototypeColumnNode(
        children =
          List(2001) {
            PrototypeColumnNode(
              repeat = PrototypeRepeat(emptyList(), "item", itemsPath = "/rows"),
              children = emptyList(),
            )
          },
      )
    val spec =
      orders()
        .copy(
          root = root,
          data =
            buildJsonObject {
              put("rows", JsonArray(List(128) { buildJsonObject { put("id", it) } }))
            },
        )
    for (authored in listOf(spec, spec.copy(data = null))) {
      controller.show("too-many-containers", authored)
      assertEquals(false, sink.replies.last().first)
      // Authored guard, validator and resolved guard report the same message whichever fires
      // first, so this pins refusal, not their order.
      assertEquals("root.children[1999]: Node limit exceeded", sink.replies.last().second)
    }
    assertTrue(host.calls.isEmpty())
    assertNull(controller.activeRuntime)
  }

  @Test
  fun `controller validation refuses an unknown data repeat field`() = runTest {
    val host = FakePrototypeHost()
    val sink = RecordingSink()
    val controller =
      PrototypeController(
        host,
        sink,
        clock = { 42L },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      )
    val invalid =
      orders()
        .copy(
          root =
            PrototypeColumnNode(
              repeat = PrototypeRepeat(emptyList(), "item", itemsPath = "/rows"),
              children = listOf(PrototypeTextNode(text = "{item.nope}")),
            ),
          data =
            buildJsonObject {
              put("rows", JsonArray(listOf(buildJsonObject { put("id", 1) })))
            },
        )
    // This pins validation refusal behaviour, not validation versus resolution order.
    controller.show("unknown-repeat-field", invalid)
    assertEquals(false, sink.replies.last().first)
    assertEquals("root.children[0].text: Unknown repeat field \"nope\"", sink.replies.last().second)
    assertTrue(host.calls.isEmpty())
    assertNull(controller.activeRuntime)
  }

  @Test
  fun `controller refuses unresolved element anchors inside data repeat templates`() = runTest {
    val host = FakePrototypeHost()
    val sink = RecordingSink()
    val controller =
      PrototypeController(
        host,
        sink,
        clock = { 42L },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      )
    val spec = orders()
    val column = spec.root as PrototypeColumnNode
    val anchored =
      (column.children.single() as PrototypeTextNode).copy(
        anchor = PrototypeElementAnchor(PrototypeSelector(testTag = "buy"), alignment = "cover"),
      )
    val template = column.copy(children = listOf(anchored))
    controller.show("outside", spec.copy(root = template.copy(repeat = null)))
    assertEquals(false, sink.replies.last().first)
    val outsideError = sink.replies.last().second
    assertEquals(
      "root.children[0].anchor: Element anchors must be resolved to bounds by the host; update the AutoMobile host",
      outsideError,
    )
    controller.show("inside", spec.copy(root = template))
    assertEquals(false, sink.replies.last().first)
    val insideError = sink.replies.last().second
    assertEquals(
      "root.repeat[0].children[0].anchor: Element anchors must be resolved to bounds by the host; update the AutoMobile host",
      insideError,
    )
    assertEquals(outsideError?.substringAfter(": "), insideError?.substringAfter(": "))
    assertTrue(host.calls.isEmpty())
    assertNull(controller.activeRuntime)
  }

  @Test
  fun `same id data show preserves pager page and renders new rows`() = runTest {
    // This pins behaviour only; it also passed before the validation-order fix.
    val host = FakePrototypeHost()
    val sink = RecordingSink()
    val controller =
      PrototypeController(
        host,
        sink,
        clock = { 42L },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      )
    val orders = orders()
    val spec =
      orders.copy(
        root =
          PrototypePagerNode(
            "pager",
            children = listOf(PrototypeTextNode(text = "first"), orders.root),
          ),
      )
    controller.show("first", spec)
    assertEquals(true, sink.replies.last().first)
    controller.interact(
      checkNotNull(controller.activeRuntime),
      PrototypeInteraction.SettledPage("pager", 1),
    )
    val changed =
      spec.copy(
        data =
          buildJsonObject {
            put("cartCount", 2)
            put(
              "orders",
              JsonArray(
                listOf(
                  buildJsonObject {
                    put("id", 7)
                    put("title", "Mocha")
                    put("total", 5)
                  },
                ),
              ),
            )
          },
      )
    controller.show("again", changed)
    assertEquals(true, sink.replies.last().first)
    val runtime = checkNotNull(controller.activeRuntime)
    assertEquals(1, runtime.current.pages["pager"])
    assertEquals("Mocha 2", runtime.renderModel().root.children[1].children.single().text)
    assertEquals(listOf("show", "replace"), host.calls)
  }
}
