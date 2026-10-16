package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/**
 * `setData`, `appendData` and `removeData` on the device (#12519): immutable `/data` writes that
 * Compose sees as a new spec, reported on `change` events. Fake clock and sequence, no device.
 */
class PrototypeDataActionsRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<PrototypeEvent>()
  private var sequence = 0L
  private val warnings = mutableListOf<String>()
  private val sink = PrototypeEventSink { events += it }

  private fun fixtures(): File =
    generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
      .map { File(it, "test/fixtures/prototype-spec") }
      .first { it.isDirectory }

  private fun validated(input: String): PrototypeSpec {
    val validation = PrototypeSpecValidator.validate(input)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private fun list(): PrototypeSpec =
    validated(File(fixtures(), "valid/data-actions-list.json").readText())

  private fun runtime(spec: PrototypeSpec, nextRevision: (() -> Long)? = null) =
    PrototypeRuntime(
      spec,
      sink,
      { 42L },
      { ++sequence },
      nextRevision = nextRevision,
      warn = { warnings += it },
    )

  private fun tap(actions: List<PrototypeAction>?) = PrototypeInteraction.Tap(checkNotNull(actions))

  /** The fixture's `[Add, Reset title, repeat column]` render children. */
  private fun PrototypeRuntime.addButton() = renderModel().root.children[0].source?.onTap

  private fun PrototypeRuntime.resetButton() = renderModel().root.children[1].source?.onTap

  /** Each repeat row is `[text, delete button]`. */
  private fun PrototypeRuntime.rows() = renderModel().root.children[2].children.chunked(2)

  private fun PrototypeRuntime.deleteRow(row: Int) = rows()[row][1].source?.onTap

  private fun PrototypeRuntime.items() = current.spec.data?.get("items")?.jsonArray

  private fun names(runtime: PrototypeRuntime) =
    runtime.items()!!.map { it.jsonObject.getValue("name").jsonPrimitive.content }

  @Test
  fun `the shared fixture decodes into the three data actions`() {
    val spec = list()
    val root = spec.root as PrototypeColumnNode
    val add = (root.children[0] as PrototypeButtonNode).onTap!!.single()
    assertTrue(add is PrototypeAppendDataAction)
    assertTrue((root.children[1] as PrototypeButtonNode).onTap!!.single() is PrototypeSetDataAction)
    val delete = ((root.children[2] as PrototypeColumnNode).children[1] as PrototypeButtonNode)
    assertEquals(
      PrototypeRemoveDataAction("/data/items/{index}"),
      delete.onTap!!.single(),
    )
  }

  @Test
  fun `a repeat row binds index into its remove path`() {
    val runtime = runtime(list())
    assertEquals(
      listOf(PrototypeRemoveDataAction("/data/items/0")),
      runtime.deleteRow(0),
    )
    assertEquals(
      listOf(PrototypeRemoveDataAction("/data/items/1")),
      runtime.deleteRow(1),
    )
  }

  @Test
  fun `appending to the list adds a repeat row and reports the write`() = runTest {
    val runtime = runtime(list())
    val before = runtime.current.spec
    assertEquals(2, runtime.rows().size)

    runtime.handle(tap(runtime.addButton()))

    assertEquals(listOf("one", "two", "new"), names(runtime))
    assertEquals(3, runtime.rows().size)
    // Writes copy: the earlier snapshot's data is untouched, and the spec is a new instance.
    assertEquals(2, before.data!!.getValue("items").jsonArray.size)
    assertNotSame(before.data, runtime.current.spec.data)
    assertSame(before.root, runtime.current.spec.root)
    val event = events.single()
    assertEquals(PrototypeEventKind.CHANGE, event.kind)
    assertEquals("/data/items", event.name)
    assertEquals(
      buildJsonObject {
        put("op", "append")
        put("value", buildJsonObject { put("name", "new") })
        put("revision", 1)
      },
      event.payload,
    )
    assertEquals("data-actions-list", event.id)
    assertEquals(42L, event.timestamp)
    assertEquals(1L, event.sequence)
    assertEquals(1L, runtime.current.revision)
  }

  @Test
  fun `removing inside a repeat deletes that row and later rows shift down`() = runTest {
    val runtime = runtime(list())

    runtime.handle(tap(runtime.deleteRow(0)))

    assertEquals(listOf("two"), names(runtime))
    assertEquals(1, runtime.rows().size)
    var event = events.last()
    assertEquals("/data/items/0", event.name)
    assertEquals(
      buildJsonObject {
        put("op", "remove")
        put("revision", 1)
      },
      event.payload,
    )

    // The surviving row is now row 0; its bound path follows it.
    assertEquals(listOf(PrototypeRemoveDataAction("/data/items/0")), runtime.deleteRow(0))
    runtime.handle(tap(runtime.deleteRow(0)))
    assertEquals(emptyList<String>(), names(runtime))
    event = events.last()
    assertEquals("/data/items/0", event.name)
    assertEquals(2L, event.sequence)
    assertEquals(2L, runtime.current.revision)
    assertEquals(0, runtime.rows().size)
  }

  @Test
  fun `setData replaces an object member`() = runTest {
    val runtime = runtime(list())
    runtime.handle(tap(runtime.resetButton()))
    assertEquals("Items", runtime.current.spec.data!!.getValue("title").jsonPrimitive.content)
    val event = events.single()
    assertEquals("/data/title", event.name)
    assertEquals(
      buildJsonObject {
        put("op", "set")
        put("value", "Items")
        put("revision", 1)
      },
      event.payload,
    )
  }

  private fun profileSpec(
    action: String = """{"type":"increment","key":"count"}""",
  ): PrototypeSpec =
    validated(
      """{"id":"profile","window":{"placement":{"type":"fullscreen"}},
        "state":{"city":"Berlin","count":1},
        "root":{"type":"column","children":[
          {"type":"text","text":"City {data:/profile/address/city}"},
          {"type":"text","id":"go","text":"go","onTap":[$action]},
          {"type":"column","repeat":{"items":{"path":"/rows"},"as":"row"},"children":[
            {"type":"text","id":"pick","text":"{row.label}","onTap":[
              {"type":"setData","path":"/data/last","value":{"item":"label"}},
              {"type":"setData","path":"/data/at","value":{"index":true}},
              {"type":"setData","path":"/data/copied/{index}","value":{"data":"/profile/name"}}]}]}]},
        "data":{"profile":{"name":"Ada","address":{"city":"Paris"}},
          "copied":["a","b"],
          "rows":[{"label":"x"},{"label":"y"}]}}""",
    )

  @Test
  fun `a nested pointer write keeps its siblings and re-binds data text`() = runTest {
    val runtime =
      runtime(
        profileSpec(
          """{"type":"setData","path":"/data/profile/address/city","value":{"state":"city"}}""",
        ),
      )
    val before = runtime.current.spec.data!!
    assertEquals("City Paris", runtime.renderModel().root.children[0].text)

    runtime.handle(tap(runtime.renderModel().root.children[1].source?.onTap))

    val data = runtime.current.spec.data!!
    assertEquals(
      buildJsonObject {
        put("name", "Ada")
        put("address", buildJsonObject { put("city", "Berlin") })
      },
      data.getValue("profile"),
    )
    assertEquals("City Berlin", runtime.renderModel().root.children[0].text)
    // The earlier data object is untouched, and the unrelated members are shared, not copied.
    assertEquals(
      "Paris",
      before
        .getValue("profile")
        .jsonObject
        .getValue("address")
        .jsonObject
        .getValue("city")
        .jsonPrimitive
        .content,
    )
    assertSame(before["rows"], data["rows"])
    val event = events.single()
    assertEquals("/data/profile/address/city", event.name)
    assertEquals(JsonPrimitive("Berlin"), event.payload!!.jsonObject.getValue("value"))
  }

  @Test
  fun `item and index bindings and a data binding resolve per repeat row`() = runTest {
    val runtime = runtime(profileSpec())
    val row = runtime.renderModel().root.children[2].children[1]

    runtime.handle(tap(row.source?.onTap))

    val data = runtime.current.spec.data!!
    assertEquals(JsonPrimitive("y"), data["last"])
    assertEquals(JsonPrimitive(1), data["at"])
    assertEquals(
      buildJsonArray {
        add("a")
        add("Ada")
      },
      data["copied"],
    )
    assertEquals(
      listOf("/data/last", "/data/at", "/data/copied/1"),
      events.map { it.name },
    )
    // Each write bumps the revision: the host orders its patches against them.
    assertEquals(
      listOf(1L, 2L, 3L),
      events.map { it.payload!!.jsonObject.getValue("revision").jsonPrimitive.long },
    )
    assertEquals(listOf(1L, 2L, 3L), events.map { it.sequence })
    assertEquals(3L, runtime.current.revision)
  }

  @Test
  fun `a refused write changes and emits nothing and the rest of the list still runs`() = runTest {
    val big = "x".repeat(PrototypeSpecValidator.MAX_PROTOTYPE_DATA_WRITE_BYTES - 128)
    val spec =
      validated(
        """{"id":"limit","window":{"placement":{"type":"fullscreen"}},
            "state":{"n":0},
            "root":{"type":"text","text":"t","onTap":[
              {"type":"setData","path":"/data/more","value":{"value":"${"y".repeat(512)}"}},
              {"type":"removeData","path":"/data/missing"},
              {"type":"appendData","path":"/data/absent","value":{"value":1}},
              {"type":"setData","path":"/data/ok","value":{"value":"fits"}},
              {"type":"increment","key":"n"}]},
            "data":{"big":"$big"}}""",
      )
    val runtime = runtime(spec)
    val before = runtime.current.spec

    runtime.handle(tap((runtime.renderModel().root.source as PrototypeTextNode).onTap))

    val data = runtime.current.spec.data!!
    // limit_exceeded and not_found leave the data as it was...
    assertFalse(data.containsKey("more"))
    assertEquals(before.data!!.getValue("big"), data.getValue("big"))
    // ...and the write that fits, then the state action after it, still ran.
    assertEquals(warnings.toString(), JsonPrimitive("fits"), data["ok"])
    assertEquals(PrototypeScalar.Numeric(1.0), runtime.current.state["n"])
    assertEquals(listOf("/data/ok", "change"), events.map { it.name })
    assertEquals(3, warnings.size)
    assertTrue(warnings[0], warnings[0].contains("/data/more"))
    assertTrue(warnings[1], warnings[1].contains("/data/missing"))
    assertTrue(warnings[2], warnings[2].contains("/data/absent"))
    assertEquals(PrototypeEventKind.CHANGE, events[0].kind)
    // The data write took revision 1; the state write after it took the next.
    assertEquals(
      1L,
      events[0].payload!!.jsonObject.getValue("revision").jsonPrimitive.long,
    )
    assertEquals(2L, runtime.current.stateRevisions["n"])
    assertEquals(2L, runtime.current.revision)
  }

  @Test
  fun `data and state writes in one list never move the revision backwards`() = runTest {
    val spec =
      validated(
        """{"id":"order","window":{"placement":{"type":"fullscreen"}},
          "state":{"a":0,"b":0},
          "root":{"type":"text","text":"t","onTap":[
            {"type":"increment","key":"a"},
            {"type":"setData","path":"/data/x","value":{"value":1}},
            {"type":"increment","key":"b"}]},
          "data":{"x":0}}""",
      )
    val runtime = runtime(spec)

    runtime.handle(tap((runtime.renderModel().root.source as PrototypeTextNode).onTap))

    val dataEvent = events.first { it.kind == PrototypeEventKind.CHANGE }
    assertEquals(
      2L,
      dataEvent.payload!!.jsonObject.getValue("revision").jsonPrimitive.long,
    )
    assertEquals(3L, runtime.current.revision)
    assertEquals(1L, runtime.current.stateRevisions["a"])
    assertEquals(3L, runtime.current.stateRevisions["b"])
  }

  @Test
  fun `the revision comes from the controller counter when one is supplied`() = runTest {
    var next = 10L
    val runtime = runtime(list(), nextRevision = { next++ })
    runtime.handle(tap(runtime.addButton()))
    assertEquals(
      10L,
      events.single().payload!!.jsonObject.getValue("revision").jsonPrimitive.long,
    )
    assertEquals(10L, runtime.current.revision)
  }

  @Test
  fun `a payload too large for an event drops the value but still reports the write`() = runTest {
    val spec =
      validated(
        """{"id":"large","window":{"placement":{"type":"fullscreen"}},
          "root":{"type":"text","text":"t","onTap":[
            {"type":"setData","path":"/data/blob","value":{"value":"${"z".repeat(5000)}"}}]},
          "data":{"blob":""}}""",
      )
    val runtime = runtime(spec)
    runtime.handle(tap((runtime.renderModel().root.source as PrototypeTextNode).onTap))
    assertEquals(5000, runtime.current.spec.data!!.getValue("blob").jsonPrimitive.content.length)
    assertEquals(
      buildJsonObject {
        put("op", "set")
        put("revision", 1)
      },
      events.single().payload,
    )
  }

  @Test
  fun `a write with no host connected lands in the offline buffer in order`() = runTest {
    val buffer = PrototypeOfflineEventBuffer()
    val runtime =
      PrototypeRuntime(list(), PrototypeEventSink { buffer.add(it) }, { 42L }, { ++sequence })

    runtime.handle(tap(runtime.addButton()))
    runtime.handle(tap(runtime.deleteRow(0)))

    val held = buffer.drain()
    assertEquals(listOf("/data/items", "/data/items/0"), held.map { it.name })
    assertEquals(listOf(1L, 2L), held.map { it.sequence })
    assertEquals(
      listOf("append", "remove"),
      held.map { it.payload!!.jsonObject.getValue("op").jsonPrimitive.content },
    )
    assertEquals(0L, buffer.dropped)
  }

  @Test
  fun `a closed runtime ignores data actions`() = runTest {
    val runtime = runtime(list())
    runtime.close()
    runtime.handle(tap(runtime.addButton()))
    assertTrue(events.isEmpty())
    assertEquals(2, runtime.items()!!.size)
  }

  @Test
  fun `a state write is revalidated against the data an earlier action in the list changed`() =
    runTest {
      val spec =
        validated(
          """{"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"k_a":true,"k_b":true},""" +
            """"data":{"items":[{"id":"a"}]},"root":{"type":"column","children":[""" +
            """{"type":"button","label":"Go","onTap":[""" +
            """{"type":"appendData","path":"/data/items","value":{"value":{"id":"b"}}},""" +
            """{"type":"setState","key":"k_b","value":"oops"}]},""" +
            """{"type":"column","repeat":{"items":{"path":"/items"},"as":"item"},"children":[""" +
            """{"type":"switch","stateKey":"k_{item.id}"}]}]}}""",
        )
      val runtime = runtime(spec)

      val failure = runCatching {
        runtime.handle(tap(runtime.renderModel().root.children[0].source?.onTap))
      }

      assertTrue(failure.exceptionOrNull() is IllegalArgumentException)
      // The live prototype never holds a string where a row's switch needs a boolean.
      assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["k_b"])
    }
}
