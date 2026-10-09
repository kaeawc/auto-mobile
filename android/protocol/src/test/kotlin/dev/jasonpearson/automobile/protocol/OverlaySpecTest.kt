package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class OverlaySpecTest {
  @TestFactory
  fun validFixtures(): List<DynamicTest> = valid.map { file ->
    DynamicTest.dynamicTest("decode ${file.name}") {
      val result = OverlaySpecValidator.validate(validJson.getValue(file))
      assertTrue(result is OverlaySpecValidation.Success, result.toString())
      val spec = (result as OverlaySpecValidation.Success).spec
      val encoded = Json.encodeToString(OverlaySpec.serializer(), spec)
      assertTrue(OverlaySpecValidator.validate(encoded) is OverlaySpecValidation.Success)
    }
  }

  @TestFactory
  fun invalidFixtures(): List<DynamicTest> = invalid.map { file ->
    val fixture = invalidJson.getValue(file)
    DynamicTest.dynamicTest("reject ${file.name}") {
      val result = OverlaySpecValidator.validate(invalidSpec.getValue(file))
      assertTrue(result is OverlaySpecValidation.Failure, result.toString())
      assertEquals(
        fixture.getValue("expectedPath").jsonPrimitive.content,
        (result as OverlaySpecValidation.Failure).error.path,
      )
    }
  }

  @Test
  fun `fixtures are nonempty and cover every node action and placement`() {
    assertTrue(valid.isNotEmpty())
    assertTrue(invalid.isNotEmpty())
    val tags = mutableSetOf<String>()
    for (file in valid) collectTags(Json.parseToJsonElement(validJson.getValue(file)), tags)
    for (type in
      OverlaySpecValidator.nodeTypes +
        OverlaySpecValidator.actionTypes +
        OverlaySpecValidator.placementTypes) {
      assertTrue(tags.contains(type), "Missing fixture for $type")
    }
  }

  @Test
  fun `every node type has the same fields in the Kotlin models and the shared contract`() {
    val contract =
      Json.parseToJsonElement(
          checkNotNull(javaClass.getResourceAsStream("/overlay-spec-contract.json"))
            .readBytes()
            .decodeToString(),
        )
        .jsonObject
    val variants =
      contract
        .getValue("definitions")
        .jsonObject
        .getValue("node")
        .jsonObject
        .getValue("variants")
        .jsonObject
    // A sealed serializer's descriptor holds the discriminator, then one element per subclass.
    val subclasses = OverlayNode.serializer().descriptor.getElementDescriptor(1)
    val models =
      (0 until subclasses.elementsCount).associate { index ->
        val node = subclasses.getElementDescriptor(index)
        node.serialName to ((0 until node.elementsCount).map(node::getElementName) + "type").toSet()
      }
    assertEquals(variants.keys, models.keys)
    for ((type, variant) in variants) {
      assertEquals(variant.jsonObject.getValue("fields").jsonObject.keys, models[type], type)
    }
  }

  @Test
  fun `theme colours have the same fields in the Kotlin model and the shared contract`() {
    val definitions =
      Json.parseToJsonElement(
          checkNotNull(javaClass.getResourceAsStream("/overlay-spec-contract.json"))
            .readBytes()
            .decodeToString(),
        )
        .jsonObject
        .getValue("definitions")
        .jsonObject
    val fields = definitions.getValue("themeColors").jsonObject.getValue("fields").jsonObject.keys
    val descriptor = OverlaySpecThemeColors.serializer().descriptor
    assertEquals(fields, (0 until descriptor.elementsCount).map(descriptor::getElementName).toSet())
    // Every override is exactly one of the colour roles a style colour can name.
    val roles =
      definitions
        .getValue("colorValue")
        .jsonObject
        .getValue("options")
        .jsonArray
        .map { it.jsonObject }
        .single { it.getValue("kind").jsonPrimitive.content == "enum" }
        .getValue("values")
        .jsonArray
        .map { it.jsonPrimitive.content }
        .toSet()
    assertEquals(roles, fields - setOf("seed", "source"))
  }

  @Test
  fun `style has the same fields in the Kotlin model and the shared contract`() {
    val contract =
      Json.parseToJsonElement(
          checkNotNull(javaClass.getResourceAsStream("/overlay-spec-contract.json"))
            .readBytes()
            .decodeToString(),
        )
        .jsonObject
    val fields =
      contract
        .getValue("definitions")
        .jsonObject
        .getValue("style")
        .jsonObject
        .getValue("fields")
        .jsonObject
        .keys
    val descriptor = OverlayStyle.serializer().descriptor
    assertEquals(fields, (0 until descriptor.elementsCount).map(descriptor::getElementName).toSet())
  }

  @Test
  fun `per-corner radii accept only the four named nonnegative corners`() {
    fun spec(radius: String) =
      """{"id":"a","window":{"placement":{"type":"fullscreen"}},""" +
        """"root":{"type":"box","children":[],"style":{"cornerRadius":$radius}}}"""
    val accepted = OverlaySpecValidator.validate(spec("""{"topStart":12,"bottomEnd":0}"""))
    assertTrue(accepted is OverlaySpecValidation.Success, accepted.toString())
    assertEquals(
      OverlayCornerRadius.Corners(topStart = 12.0, bottomEnd = 0.0),
      (accepted as OverlaySpecValidation.Success).spec.root.style?.cornerRadius,
    )
    for (bad in listOf("""{"top":1}""", """{"topEnd":-1}""", """{"topEnd":"large"}""")) {
      val rejected = OverlaySpecValidator.validate(spec(bad))
      assertTrue(rejected is OverlaySpecValidation.Failure, bad)
    }
  }

  @Test
  fun `button and list item icons accept the full icon set`() {
    for (root in
      listOf(
        """{"type":"button","label":"Connect","icon":"wifi"}""",
        """{"type":"listItem","headline":"Wi-Fi","leadingIcon":"wifi"}""",
        """{"type":"listItem","headline":"Wi-Fi","trailing":{"type":"icon","name":"wifi"}}""",
      )) {
      val spec = """{"id":"a","window":{"placement":{"type":"fullscreen"}},"root":$root}"""
      val accepted = OverlaySpecValidator.validate(spec)
      assertTrue(accepted is OverlaySpecValidation.Success, accepted.toString())
      val unknown = OverlaySpecValidator.validate(spec.replace("\"wifi\"", "\"not_an_icon\""))
      assertTrue(unknown is OverlaySpecValidation.Failure, root)
    }
  }

  @Test
  fun `bound state keys take placeholders and reject any other brace text`() {
    for (key in listOf("liked", "liked_{item.id}", "{index}_{props.k}", "9_{item.id}")) assertTrue(
      OverlayRepeatTemplate.isBoundKey(key),
      key,
    )
    for (key in
      listOf("9a", "", "liked_{item}", "liked-{item.id}", "liked_{item.id", "{}")) assertFalse(
      OverlayRepeatTemplate.isBoundKey(key),
      key,
    )
  }

  @Test
  fun `raw byte limit includes whitespace and accepts its exact boundary`() {
    val input = validJson.getValue(valid.first())
    val padding =
      OverlaySpecValidator.MAX_OVERLAY_SPEC_BYTES - input.toByteArray(Charsets.UTF_8).size
    assertTrue(
      OverlaySpecValidator.validate(input + " ".repeat(padding)) is OverlaySpecValidation.Success,
    )
    val rejected =
      OverlaySpecValidator.validate(input + " ".repeat(padding + 1))
        as OverlaySpecValidation.Failure
    assertEquals("$", rejected.error.path)
  }

  @Test
  fun `payload accepts the exact compact JSON boundary`() {
    val payload = "x".repeat(OverlaySpecValidator.MAX_OVERLAY_EMIT_PAYLOAD_BYTES - 2)
    val input =
      """{"id":"a","window":{"placement":{"type":"fullscreen"}},"root":{"type":"spacer","onTap":[{"type":"emit","name":"a","payload":"$payload"}]}}"""
    assertTrue(OverlaySpecValidator.validate(input) is OverlaySpecValidation.Success)
  }

  @Test
  fun `non JSON numeric tokens and literal string controls are rejected`() {
    for (input in listOf("NaN", "Infinity", "01", "+1", "1.", "1e", "\"literal\nnewline\"")) {
      val result = OverlaySpecValidator.validate(input) as OverlaySpecValidation.Failure
      assertEquals("$", result.error.path, input)
    }
  }

  @Test
  fun `malformed JSON reports the envelope path`() {
    val result = OverlaySpecValidator.validate("{") as OverlaySpecValidation.Failure
    assertEquals("$", result.error.path)
  }

  private fun collectTags(element: JsonElement, tags: MutableSet<String>) {
    when (element) {
      is JsonObject -> {
        (element["type"] as? JsonPrimitive)?.content?.let { tags.add(it) }
        for (child in element.values) collectTags(child, tags)
      }
      is JsonArray -> for (child in element) collectTags(child, tags)
      else -> Unit
    }
  }

  companion object {
    private lateinit var validJson: Map<File, String>
    private lateinit var invalidJson: Map<File, JsonObject>
    private lateinit var invalidSpec: Map<File, String>
    private lateinit var valid: List<File>
    private lateinit var invalid: List<File>

    @BeforeAll
    @JvmStatic
    fun loadFixtures() {
      val relative = "test/fixtures/overlay-spec"
      val directory =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, relative) }
          .firstOrNull { it.isDirectory } ?: error("Could not locate $relative")
      valid =
        File(directory, "valid")
          .listFiles()
          .orEmpty()
          .filter { it.extension == "json" }
          .sortedBy { it.name }
      invalid =
        File(directory, "invalid")
          .listFiles()
          .orEmpty()
          .filter { it.extension == "json" }
          .sortedBy { it.name }
      validJson = valid.associateWith { it.readText() }
      invalidJson = invalid.associateWith { Json.parseToJsonElement(it.readText()).jsonObject }
      invalidSpec = invalidJson.mapValues { it.value.getValue("spec").toString() }
      // Materialize every lazy serializer before JUnit starts measuring each test.
      for (input in validJson.values) {
        val decoded = OverlaySpecValidator.validate(input)
        if (decoded is OverlaySpecValidation.Success)
          Json.encodeToString(OverlaySpec.serializer(), decoded.spec)
      }
    }
  }
}
