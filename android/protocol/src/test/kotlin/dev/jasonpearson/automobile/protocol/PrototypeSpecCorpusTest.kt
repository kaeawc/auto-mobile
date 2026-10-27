package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeSpecFixtures.invalid
import dev.jasonpearson.automobile.protocol.PrototypeSpecFixtures.invalidJson
import dev.jasonpearson.automobile.protocol.PrototypeSpecFixtures.invalidSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecFixtures.valid
import dev.jasonpearson.automobile.protocol.PrototypeSpecFixtures.validJson
import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeSpecCorpusTest {
  @Test
  fun `secure library policy preserves nonlibrary and opaque literal bindings`() {
    val unbound = valid.first { it.name == "strict-library-secure-unbound.json" }
    assertTrue(
      PrototypeSpecValidator.validate(validJson.getValue(unbound), library = true)
        is PrototypeSpecValidation.Success,
    )
    for (file in invalid.filter { it.name.startsWith("strict-library-secure-") }) {
      assertTrue(
        PrototypeSpecValidator.validate(invalidSpec.getValue(file))
          is PrototypeSpecValidation.Success,
        file.name,
      )
      // Message parity with TS and Swift: request sinks, action payloads and storage differ.
      val library = PrototypeSpecValidator.validate(invalidSpec.getValue(file), library = true)
      assertEquals(
        invalidJson.getValue(file).getValue("expectedMessage").jsonPrimitive.content,
        (library as PrototypeSpecValidation.Failure).error.message,
        file.name,
      )
    }
  }

  @Test
  fun `all three corpus runners consume the complete captured inventory`() {
    val inventory =
      Json.parseToJsonElement(File(fixtureDirectory(), "corpus.json").readText()).jsonObject
    assertEquals(
      inventory.getValue("valid").jsonArray.map { it.jsonPrimitive.content },
      valid.map { it.name },
    )
    assertEquals(
      inventory.getValue("invalid").jsonArray.map { it.jsonPrimitive.content },
      invalid.map { it.name },
    )
    for (file in valid) {
      val spec =
        Json.parseToJsonElement(PrototypeStrictJson.prepare(validJson.getValue(file))).jsonObject
      assertEquals(
        inventory
          .getValue("validCapabilities")
          .jsonObject
          .getValue(file.name)
          .jsonArray
          .map { it.jsonPrimitive.content }
          .toSet(),
        PrototypeStrictPolicy.required(spec),
        file.name,
      )
    }
  }

  @TestFactory
  fun validFixtures(): List<DynamicTest> = valid.map { file ->
    DynamicTest.dynamicTest("decode ${file.name}") {
      val result = PrototypeSpecValidator.validate(validJson.getValue(file))
      assertTrue(result is PrototypeSpecValidation.Success, result.toString())
      val spec = (result as PrototypeSpecValidation.Success).spec
      val encoded = Json.encodeToString(PrototypeSpec.serializer(), spec)
      assertTrue(PrototypeSpecValidator.validate(encoded) is PrototypeSpecValidation.Success)
    }
  }

  @TestFactory
  fun invalidFixtures(): List<DynamicTest> = invalid.map { file ->
    val fixture = invalidJson.getValue(file)
    DynamicTest.dynamicTest("reject ${file.name}") {
      val options = fixture["options"] as? JsonObject
      val supported =
        (options?.get("supportedCapabilities") as? JsonArray)
          ?.map { it.jsonPrimitive.content }
          ?.toSet()
      val library = options?.get("library")?.jsonPrimitive?.booleanOrNull ?: false
      val result =
        if (fixture["rawBytesBase64"] != null) {
          PrototypeSpecValidator.validate(
            java.util.Base64.getDecoder()
              .decode(fixture.getValue("rawBytesBase64").jsonPrimitive.content),
            supported,
            library,
          )
        } else
          PrototypeSpecValidator.validate(
            invalidSpec.getValue(file),
            supported,
            library,
            (options?.get("shareAssetIds") as? JsonArray)
              ?.map { it.jsonPrimitive.content }
              ?.toSet(),
          )
      assertTrue(result is PrototypeSpecValidation.Failure, result.toString())
      assertEquals(
        fixture.getValue("expectedPath").jsonPrimitive.content,
        (result as PrototypeSpecValidation.Failure).error.path,
      )
      val messageCase =
        listOf(
            "list-",
            "request-append-to-",
            "node-list",
            "listRepeat",
            "action-request-append",
            "lazy_list",
          )
          .any(file.name::contains)
      if (
        (messageCase || file.name.startsWith("share-")) && fixture.containsKey("expectedMessage")
      ) {
        assertEquals(
          fixture.getValue("expectedMessage").jsonPrimitive.content,
          result.error.message,
        )
      }
    }
  }

  @TestFactory
  fun hostRequestsWithoutLibrary(): List<DynamicTest> =
    invalid
      .filter { it.name.startsWith("strict-library-via-host") }
      .map { file ->
        DynamicTest.dynamicTest("accept host without library ${file.name}") {
          val input = invalidSpec.getValue(file)
          val fixture = invalidJson.getValue(file)
          assertEquals(
            PrototypeSpecValidation.Failure(
              PrototypeSpecError(
                fixture.getValue("expectedPath").jsonPrimitive.content,
                fixture.getValue("expectedMessage").jsonPrimitive.content,
              ),
            ),
            PrototypeSpecValidator.validate(input, library = true),
          )
          assertTrue(PrototypeSpecValidator.validate(input) is PrototypeSpecValidation.Success)
          assertTrue(
            PrototypeSpecValidator.validate(input, library = false)
              is PrototypeSpecValidation.Success,
          )
        }
      }

  @Test
  fun `library accepts device and default requests with opaque host shaped JSON`() {
    for (via in listOf("", ", \"via\":\"device\"")) {
      val input =
        """{"id":"safe","window":{"placement":{"type":"fullscreen"}},
          "data":{"opaque":{"type":"request","via":"host"}},
          "root":{"type":"button","label":"Load","onTap":[
            {"type":"request","method":"POST","url":"https://example.com"$via,
              "body":{"value":{"type":"request","via":"host"}},
              "onSuccess":[{"type":"emit","name":"done","payload":{"type":"request","via":"host"}}]}
          ]}}"""
      val result = PrototypeSpecValidator.validate(input, library = true)
      assertTrue(result is PrototypeSpecValidation.Success, result.toString())
    }
  }

  @Test
  fun `fixtures are nonempty and cover every node action and placement`() {
    assertTrue(valid.isNotEmpty())
    assertTrue(invalid.isNotEmpty())
    val tags = mutableSetOf<String>()
    for (file in valid) collectTags(
      Json.parseToJsonElement(PrototypeStrictJson.prepare(validJson.getValue(file))),
      tags,
    )
    for (type in
      PrototypeSpecValidator.nodeTypes +
        PrototypeSpecValidator.actionTypes +
        PrototypeSpecValidator.placementTypes) {
      assertTrue(tags.contains(type), "Missing fixture for $type")
    }
  }

  @Test
  fun `every node type has the same fields in the Kotlin models and the shared contract`() {
    val contract =
      Json.parseToJsonElement(
          checkNotNull(javaClass.getResourceAsStream("/prototype-spec-contract.json"))
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
    val subclasses = PrototypeNode.serializer().descriptor.getElementDescriptor(1)
    val models =
      (0 until subclasses.elementsCount).associate { index ->
        val node = subclasses.getElementDescriptor(index)
        node.serialName to ((0 until node.elementsCount).map(node::getElementName) + "type").toSet()
      }
    assertEquals(variants.keys, models.keys)
    val gestureTypes = setOf("box", "row", "column", "text", "image", "icon", "card")
    for ((type, fields) in models) {
      assertEquals(type in gestureTypes, "onLongPress" in fields, type)
      assertEquals(type in gestureTypes, "onDoubleTap" in fields, type)
    }
    // Foreign iOS namespaces are validated before stripping; Android fields reach the renderer.
    val stripped = setOf("ios")
    for ((type, variant) in variants) {
      assertEquals(
        variant.jsonObject.getValue("fields").jsonObject.keys - stripped,
        models[type],
        type,
      )
    }
  }

  @Test
  fun `theme colours have the same fields in the Kotlin model and the shared contract`() {
    val definitions =
      Json.parseToJsonElement(
          checkNotNull(javaClass.getResourceAsStream("/prototype-spec-contract.json"))
            .readBytes()
            .decodeToString(),
        )
        .jsonObject
        .getValue("definitions")
        .jsonObject
    val fields = definitions.getValue("themeColors").jsonObject.getValue("fields").jsonObject.keys
    val descriptor = PrototypeSpecThemeColors.serializer().descriptor
    assertEquals(fields, (0 until descriptor.elementsCount).map(descriptor::getElementName).toSet())
    // Every override is exactly one of the colour roles a style colour can name.
    val roles =
      definitions
        .getValue("colorRole")
        .jsonObject
        .getValue("values")
        .jsonArray
        .map { it.jsonPrimitive.content }
        .toSet()
    assertEquals(roles, fields - setOf("seed", "source", "light", "dark"))
    // A per-mode map overrides exactly the roles the flat overrides do.
    assertEquals(
      roles,
      definitions.getValue("themeModeColors").jsonObject.getValue("fields").jsonObject.keys,
    )
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

  @TestFactory
  fun routeDiagnostics(): List<DynamicTest> =
    invalid
      .filter {
        it.name.startsWith("routes-") && invalidJson.getValue(it)["expectedMessage"] != null
      }
      .map { file ->
        DynamicTest.dynamicTest("route diagnostic ${file.name}") {
          val fixture = invalidJson.getValue(file)
          assertEquals(
            PrototypeSpecValidation.Failure(
              PrototypeSpecError(
                fixture.getValue("expectedPath").jsonPrimitive.content,
                fixture.getValue("expectedMessage").jsonPrimitive.content,
              ),
            ),
            PrototypeSpecValidator.validate(
              invalidSpec.getValue(file),
              ((fixture["options"] as? JsonObject)?.get("supportedCapabilities") as? JsonArray)
                ?.map { it.jsonPrimitive.content }
                ?.toSet(),
            ),
          )
        }
      }

  companion object {
    @BeforeAll @JvmStatic fun loadFixtures() = PrototypeSpecFixtures.loadFixtures()
  }
}

internal object PrototypeSpecFixtures {
  lateinit var validJson: Map<File, String>
  lateinit var invalidJson: Map<File, JsonObject>
  lateinit var invalidSpec: Map<File, String>
  lateinit var valid: List<File>
  lateinit var invalid: List<File>

  fun loadFixtures() {
    if (::validJson.isInitialized) return
    val directory = fixtureDirectory()
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
    invalidSpec = invalidJson.mapValues {
      it.value["rawJson"]?.jsonPrimitive?.content ?: it.value["spec"]?.toString() ?: "null"
    }
    // Materialize every lazy serializer before JUnit starts measuring each test.
    for (input in validJson.values) {
      val decoded = PrototypeSpecValidator.validate(input)
      if (decoded is PrototypeSpecValidation.Success)
        Json.encodeToString(PrototypeSpec.serializer(), decoded.spec)
    }
  }
}

/** Shared repository-root lookup for the protocol fixture suites. */
internal fun fixtureDirectory(): File {
  val relative = "test/fixtures/prototype-spec"
  return generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) {
      it.parentFile
    }
    .map { File(it, relative) }
    .firstOrNull { it.isDirectory } ?: error("Could not locate $relative")
}
