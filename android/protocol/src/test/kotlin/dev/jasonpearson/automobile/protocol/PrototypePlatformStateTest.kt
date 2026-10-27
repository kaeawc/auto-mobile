package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypePlatformStateTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warm() {
      val spec =
        """{"id":"warm","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["device"]},"root":{"type":"text","text":"{platform:/device/os}","visibleWhen":{"platform":"/device/os","equals":"android"}}}"""
      val refs = PrototypeBundleSpec.references(spec.toByteArray())
      PrototypeBundleCapabilities.required(refs)
      PrototypeDataResolver.resolveRoot(
        refs.spec.getValue("root").jsonObject,
        null,
        JsonObject(emptyMap()),
      )
      val device = Json.parseToJsonElement("""{"device":{"widthClass":"compact"}}""").jsonObject
      for (op in listOf("equals", "notEquals", "gt", "lt")) {
        val node =
          Json.parseToJsonElement(
              """{"type":"text","text":"{platform:/device/widthClass}:{platform:/device/heightClass}","visibleWhen":{"platform":"/device/heightClass","$op":1}}""",
            )
            .jsonObject
        PrototypeDataResolver.resolveRoot(node, null, device)
      }
    }
  }

  private fun objectOf(text: String) = Json.parseToJsonElement(text).jsonObject

  @Test
  fun `portable width class comparisons accept native union and reject other literals`() {
    for (op in listOf("equals", "notEquals")) {
      for (value in listOf("compact", "medium", "expanded", "regular", "wide")) {
        val spec =
          """{"id":"device","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["device"]},"root":{"type":"spacer","visibleWhen":{"platform":"/device/widthClass","$op":"$value"}}}"""
        assertEquals(
          value != "wide",
          PrototypeSpecValidator.validate(spec) is PrototypeSpecValidation.Success,
        )
      }
    }
  }

  @Test
  fun `bundle requirements include contract module capability for declarations and reads`() {
    for (root in
      listOf("{\"type\":\"spacer\"}", "{\"type\":\"text\",\"text\":\"{platform:/device/os}\"}")) {
      val spec =
        """{"id":"device","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["device"]},"root":$root}"""
      val refs = PrototypeBundleSpec.references(spec.toByteArray())
      assertTrue(
        PrototypeBundleCapabilities.required(refs)
          .containsAll(listOf("prototype_platform_v1", "prototype_platform_device_v1")),
      )
    }
  }

  @Test
  fun `conditions and text follow platform snapshots with missing data semantics`() {
    val root =
      objectOf(
        """{"type":"text","text":"{platform:/device/widthClass}:{platform:/device/heightClass}","visibleWhen":{"platform":"/device/widthClass","equals":"expanded"}}""",
      )
    val compact = objectOf("""{"device":{"widthClass":"compact"}}""")
    val expanded = objectOf("""{"device":{"widthClass":"expanded"}}""")
    val before = PrototypeDataResolver.resolveRoot(root, null, compact)
    val after = PrototypeDataResolver.resolveRoot(root, null, expanded)
    assertEquals("compact:", before.getValue("text").jsonPrimitive.content)
    assertTrue("any" in before.getValue("visibleWhen").jsonObject)
    assertTrue("all" in after.getValue("visibleWhen").jsonObject)
    for ((op, expected) in
      listOf("equals" to false, "notEquals" to true, "gt" to false, "lt" to false)) {
      val condition =
        objectOf("""{"type":"spacer","visibleWhen":{"platform":"/device/heightClass","$op":1}}""")
      val result = PrototypeDataResolver.resolveRoot(condition, null, compact)
      assertEquals(expected, "all" in result.getValue("visibleWhen").jsonObject)
    }
  }

  @Test
  fun `substitution does not rescan replacement text`() {
    val root = objectOf("""{"type":"text","text":"{platform:/device/osVersion} {data:/name}"}""")
    val result =
      PrototypeDataResolver.resolveRoot(
        root,
        objectOf("""{"name":"ok"}"""),
        objectOf("""{"device":{"osVersion":"{data:/name}"}}"""),
      )
    assertEquals("{data:/name} ok", result.getValue("text").jsonPrimitive.content)
  }

  @Test
  fun `platform and handler bindings use their own read only sources`() {
    val inputs =
      object : EmitContextInputs {
        override fun state(key: String): JsonElement? = null

        override fun page(id: String): Int? = null

        override fun data(pointer: String): JsonElement? = null

        override fun platform(pointer: String): JsonElement? =
          if (pointer == "/device/pointer") JsonPrimitive(true) else null

        override fun event(pointer: String): JsonElement? =
          if (pointer == "/pointer") JsonPrimitive(false) else null
      }
    assertEquals(
      PrototypeDataValue.Resolved(JsonPrimitive(true)),
      PrototypeDataWriter.resolveValue(objectOf("""{"platform":"/device/pointer"}"""), inputs),
    )
    assertEquals(
      PrototypeDataValue.Resolved(JsonPrimitive(false)),
      PrototypeDataWriter.resolveValue(objectOf("""{"event":"/pointer"}"""), inputs),
    )
    assertTrue(
      PrototypeDataWriter.resolveValue(objectOf("""{"platform":"/device/heightClass"}"""), inputs)
        is PrototypeDataValue.Failure,
    )
  }
}
