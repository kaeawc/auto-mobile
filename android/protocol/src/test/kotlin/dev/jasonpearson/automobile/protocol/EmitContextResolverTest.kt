package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class EmitContextResolverTest {
  private class FakeInputs(fixture: JsonObject) : EmitContextInputs {
    private val state = fixture.getValue("state").jsonObject.toMutableMap()
    private val pages = fixture.getValue("pages").jsonObject
    private val data = fixture.getValue("data").jsonObject

    init {
      for (action in fixture.getValue("precedingActions").jsonArray) {
        val write = action.jsonObject
        state[write.getValue("key").jsonPrimitive.content] = write.getValue("value")
      }
    }

    override fun state(key: String): JsonElement? = state[key]

    override fun page(id: String): Int? = pages[id]?.jsonPrimitive?.int

    override fun data(pointer: String): JsonElement? = PrototypeDataPointer.resolve(data, pointer)
  }

  @TestFactory
  fun resolutionFixtures(): List<DynamicTest> = fixtures.map { (name, fixture) ->
    DynamicTest.dynamicTest(name) {
      val root = fixture.getValue("spec").jsonObject.getValue("root").jsonObject
      val index = fixture["repeatIndex"]?.jsonPrimitive?.int
      val node =
        if (index != null || root["type"] == JsonPrimitive("pager"))
          root.getValue("children").jsonArray[0].jsonObject
        else root
      val emit = node.getValue("onTap").jsonArray[0].jsonObject
      var bindings = emit.getValue("context").jsonObject.mapValues { it.value.jsonObject }
      if (index != null) {
        val repeat = root.getValue("repeat").jsonObject
        val source = repeat.getValue("items")
        val rows =
          if (source is JsonArray) source
          else
            PrototypeRepeatData(fixture.getValue("data").jsonObject)
              .array(source.jsonObject.getValue("path").jsonPrimitive.content)
        bindings =
          PrototypeRepeatTemplate.bindEmitContext(
            bindings,
            repeat.getValue("as").jsonPrimitive.content,
            rows[index].jsonObject,
            index,
          )
      }
      val result = EmitContextResolver.resolve(bindings, FakeInputs(fixture))
      val expected = fixture.getValue("expected").jsonObject
      assertEquals(expected.getValue("context"), result.context)
      assertEquals(expected["contextTruncated"]?.jsonPrimitive?.boolean, result.contextTruncated)
      assertEquals(
        expected.getValue("context").jsonObject.keys.toList(),
        result.context.keys.toList(),
      )
    }
  }

  @Test
  fun truncationUsesUnsignedUtf8InsteadOfUtf16NameOrder() {
    val bmp = "\uE000"
    val supplementary = "\uD800\uDC00"
    val value = JsonPrimitive("x".repeat(4085))
    val bindings =
      linkedMapOf(
        supplementary to JsonObject(mapOf("value" to JsonPrimitive(1))),
        bmp to JsonObject(mapOf("value" to value)),
      )
    val result = EmitContextResolver.resolve(bindings, FakeInputs(fixtures.first().second))
    assertEquals(JsonObject(mapOf(bmp to value)), result.context)
    assertEquals(true, result.contextTruncated)
  }

  @Test
  fun decodedBindingsRetainDeclarationOrderAndArbitraryNames() {
    val decoded =
      Json.decodeFromJsonElement(PrototypeAction.serializer(), orderedEmit) as PrototypeEmitAction
    val bindings = checkNotNull(decoded.context)
    assertEquals(orderedEmit.getValue("context").jsonObject.keys.toList(), bindings.keys.toList())
    assertTrue("__proto__" in bindings)
    val encoded = Json.encodeToJsonElement(PrototypeAction.serializer(), decoded).jsonObject
    assertEquals(orderedEmit.getValue("context"), encoded.getValue("context"))
    assertEquals(bindings.keys.toList(), encoded.getValue("context").jsonObject.keys.toList())
  }

  @Test
  fun eventFieldsAreOmittedEvenWhenDefaultsAreEncoded() {
    val encoder = Json { encodeDefaults = true }
    val event = PrototypeEvent(0L, "panel", 1L, PrototypeEventKind.EMIT, "pick", null, emptyMap())
    val omitted = encoder.encodeToJsonElement(PrototypeEvent.serializer(), event).jsonObject
    assertFalse("context" in omitted)
    assertFalse("contextTruncated" in omitted)
    val context = JsonObject(linkedMapOf("__proto__" to JsonPrimitive(3)))
    val present =
      encoder
        .encodeToJsonElement(
          PrototypeEvent.serializer(),
          event.copy(context = context, contextTruncated = true),
        )
        .jsonObject
    assertEquals(context, present["context"])
    assertEquals(JsonPrimitive(true), present["contextTruncated"])
    val complete =
      encoder
        .encodeToJsonElement(PrototypeEvent.serializer(), event.copy(context = context))
        .jsonObject
    assertFalse("contextTruncated" in complete)
    assertThrows(IllegalArgumentException::class.java) { event.copy(contextTruncated = false) }
  }

  companion object {
    private lateinit var orderedEmit: JsonObject
    private lateinit var fixtures: List<Pair<String, JsonObject>>

    @JvmStatic
    @BeforeAll
    fun loadFixtures() {
      fixtures =
        File(fixtureDirectory(), "emit-context/resolve")
          .listFiles()
          .orEmpty()
          .filter { it.extension == "json" }
          .sortedBy { it.name }
          .map { it.name to Json.parseToJsonElement(it.readText()).jsonObject }
      check(fixtures.isNotEmpty())
      orderedEmit =
        fixtures
          .single { it.first == "arbitrary-names.json" }
          .second
          .getValue("spec")
          .jsonObject
          .getValue("root")
          .jsonObject
          .getValue("onTap")
          .jsonArray[0]
          .jsonObject
      Json.decodeFromJsonElement(PrototypeAction.serializer(), orderedEmit)
      PrototypeSpecValidator.validate("{}")
      Json.encodeToString(
        PrototypeEvent.serializer(),
        PrototypeEvent(0L, "warm", 1L, PrototypeEventKind.EMIT, null, null, emptyMap()),
      )
      EmitContextResolver.resolve(emptyMap(), FakeInputs(fixtures.first().second))
    }
  }
}
