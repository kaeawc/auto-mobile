package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeStateWriteValidatorTest {
  @TestFactory
  fun `fixture states agree with full validation`(): List<DynamicTest> =
    fixtures.flatMap { fixture ->
      val (name, spec, prepared) = fixture
      val original = spec.state.orEmpty()
      val candidates = buildList {
        add("unchanged" to original)
        add("unbound" to (original + ("new_key" to PrototypeScalar.Text("é😀\n\"\\\uD800"))))
        add("invalid key" to (original + ("bad-key" to PrototypeScalar.Numeric(1.0))))
        add("oversize" to (original + ("large" to PrototypeScalar.Text(oversize))))
        add("empty" to emptyMap())
        for (key in original.keys) {
          for (value in
            listOf(
              PrototypeScalar.Text("not-a-date-or-option"),
              PrototypeScalar.BooleanValue(true),
              PrototypeScalar.Numeric(-1.0),
              PrototypeScalar.Numeric(100000.0),
              PrototypeScalar.Numeric(0.5),
            )) add("$key=$value" to (original + (key to value)))
        }
      }
      candidates.map { (label, state) ->
        DynamicTest.dynamicTest("$name $label") {
          assertEquals(fullError(spec, state), prepared.validate(state))
        }
      }
    }

  @TestFactory
  fun `each state rule family actually rejects`(): List<DynamicTest> =
    rejectionCases.map { (name, key, value) ->
      val fixture = fixtures.first { it.name == name }
      DynamicTest.dynamicTest("$name rejects $key") {
        val state = fixture.spec.state.orEmpty() + (key to value)
        val expected = fullError(fixture.spec, state)
        assertNotNull(expected)
        assertEquals(expected, fixture.prepared.validate(state))
      }
    }

  @TestFactory
  fun `byte boundary is exact with omitted and present state`(): List<DynamicTest> =
    listOf(false, true).map { present ->
      DynamicTest.dynamicTest("byte boundary present=$present") {
        val spec = simple(if (present) mapOf("old" to PrototypeScalar.Text("é😀")) else null)
        val empty = mapOf("text" to PrototypeScalar.Text(""))
        val size =
          encoder
            .encodeToString(PrototypeSpec.serializer(), spec.copy(state = empty))
            .toByteArray(Charsets.UTF_8)
            .size
        val padding = PrototypeSpecValidator.MAX_PROTOTYPE_SPEC_BYTES - size
        val prepared = PrototypeSpecValidator.prepareStateWrites(spec, encoder)
        for (extra in 0..1) {
          val state = mapOf("text" to PrototypeScalar.Text("x".repeat(padding + extra)))
          val encoded = encoder.encodeToString(PrototypeSpec.serializer(), spec.copy(state = state))
          assertEquals(
            PrototypeSpecValidator.MAX_PROTOTYPE_SPEC_BYTES + extra,
            encoded.toByteArray(Charsets.UTF_8).size,
          )
          assertEquals(fullError(spec, state), prepared.validate(state))
          if (extra == 0) assertNull(prepared.validate(state))
          else
            assertEquals(
              PrototypeSpecError("$", "Spec byte limit exceeded"),
              prepared.validate(state),
            )
        }
      }
    }

  @TestFactory
  fun `invalid bases retain the full path`(): List<DynamicTest> =
    listOf(
        simple(null).copy(id = ""),
        simple(null).copy(root = PrototypeTextFieldNode(stateKey = "text")),
        simple(mapOf("flag" to PrototypeScalar.BooleanValue(false)))
          .copy(
            root =
              PrototypeSwitchNode(
                stateKey = "flag",
                onTap =
                  listOf(
                    PrototypeSetStateAction("flag", PrototypeScalar.Text("wrong")),
                  ),
              ),
          ),
      )
      .flatMap { spec ->
        val prepared = PrototypeSpecValidator.prepareStateWrites(spec, encoder)
        listOf(
            emptyMap(),
            mapOf("text" to PrototypeScalar.Text("fixed")),
            mapOf("bad-key" to PrototypeScalar.BooleanValue(true)),
            mapOf("large" to PrototypeScalar.Text(oversize)),
          )
          .mapIndexed { index, state ->
            DynamicTest.dynamicTest("invalid base ${spec.root} candidate $index") {
              assertEquals(fullError(spec, state), prepared.validate(state))
            }
          }
      }

  @Test
  fun `setState binding rejection uses the same action path and message`() {
    val spec =
      simple(mapOf("flag" to PrototypeScalar.BooleanValue(false)))
        .copy(
          root =
            PrototypeSwitchNode(
              stateKey = "flag",
              onTap =
                listOf(
                  PrototypeSetStateAction("flag", PrototypeScalar.Text("wrong")),
                ),
            ),
        )
    val prepared = PrototypeSpecValidator.prepareStateWrites(spec, encoder)
    for (value in listOf(PrototypeScalar.BooleanValue(false), PrototypeScalar.BooleanValue(true))) {
      val state = mapOf("flag" to value)
      val error = checkNotNull(fullError(spec, state))
      assertEquals("root.onTap[0].value", error.path)
      assertTrue(error.message.startsWith("setState value does not fit the control"))
      assertEquals(error, prepared.validate(state))
    }
  }

  @Test
  fun `progress with an explicit max checks both type and range`() {
    val spec =
      simple(mapOf("n" to PrototypeScalar.Numeric(5.0)))
        .copy(root = PrototypeProgressNode(stateKey = "n", max = 10.0))
    val prepared = PrototypeSpecValidator.prepareStateWrites(spec, encoder)
    for (value in
      listOf(
        PrototypeScalar.Text("wrong"),
        PrototypeScalar.Numeric(-1.0),
        PrototypeScalar.Numeric(11.0),
        PrototypeScalar.Numeric(10.0),
      )) {
      val state = mapOf("n" to value)
      val expected = fullError(spec, state)
      assertEquals(expected, prepared.validate(state))
      if (value == PrototypeScalar.Numeric(10.0)) assertNull(expected) else assertNotNull(expected)
    }
  }

  @Test
  fun `non finite numbers preserve serialization exceptions even on an unserializable base`() {
    for (spec in listOf(simple(null), simple(mapOf("n" to PrototypeScalar.Numeric(Double.NaN))))) {
      val prepared = PrototypeSpecValidator.prepareStateWrites(spec, encoder)
      for (number in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
        val state = mapOf("n" to PrototypeScalar.Numeric(number))
        val full = assertThrows(SerializationException::class.java) { fullError(spec, state) }
        val actual = assertThrows(SerializationException::class.java) { prepared.validate(state) }
        assertEquals(full.message, actual.message)
        assertTrue(actual is IllegalArgumentException)
      }
      assertNull(prepared.validate(mapOf("n" to PrototypeScalar.Numeric(1.0))))
    }
  }

  @TestFactory
  fun `state actions validate all keys on each write`(): List<DynamicTest> =
    listOf(
        "toggle" to PrototypeToggleAction("flag"),
        "increment" to PrototypeIncrementAction("n"),
        "decrement" to PrototypeDecrementAction("n"),
      )
      .map { (name, action) ->
        val spec =
          simple(
              mapOf(
                "flag" to PrototypeScalar.BooleanValue(true),
                "n" to PrototypeScalar.Numeric(1.0),
              ),
            )
            .copy(root = PrototypeTextNode(text = "action", onTap = listOf(action)))
        val prepared = PrototypeSpecValidator.prepareStateWrites(spec, encoder)
        DynamicTest.dynamicTest(name) {
          val key = if (name == "toggle") "flag" else "n"
          val bad = spec.state.orEmpty() + (key to PrototypeScalar.Text("wrong"))
          assertNotNull(fullError(spec, bad))
          assertEquals(fullError(spec, bad), prepared.validate(bad))
          // A fresh, unrelated key cannot hide an already-invalid bound key.
          val unrelated = bad + ("other" to PrototypeScalar.Numeric(2.0))
          assertEquals(fullError(spec, unrelated), prepared.validate(unrelated))
        }
      }

  private fun simple(state: Map<String, PrototypeScalar>?) =
    PrototypeSpec(
      "é😀",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      state,
      PrototypeSpacerNode(),
    )

  private fun fullError(spec: PrototypeSpec, state: Map<String, PrototypeScalar>) =
    (PrototypeSpecValidator.validate(
        encoder.encodeToString(PrototypeSpec.serializer(), spec.copy(state = state)),
      ) as? PrototypeSpecValidation.Failure)
      ?.error

  private data class Fixture(
    val name: String,
    val spec: PrototypeSpec,
    val prepared: PrototypeStateWriteValidator,
  )

  companion object {
    private val encoder = Json { classDiscriminator = "type" }
    private val oversize = "x".repeat(PrototypeSpecValidator.MAX_PROTOTYPE_SPEC_BYTES)
    private lateinit var fixtures: List<Fixture>
    private val rejectionCases =
      listOf(
        Triple("set-state-matching-values", "t", PrototypeScalar.Numeric(1.0)),
        Triple("material-controls", "enabled", PrototypeScalar.Text("wrong")),
        Triple("material-controls", "repeat", PrototypeScalar.Text("wrong")),
        Triple("selection-controls", "sound", PrototypeScalar.Numeric(1.0)),
        Triple("selection-controls", "sync", PrototypeScalar.Text("wrong")),
        Triple("selection-controls", "wifi", PrototypeScalar.Text("wrong")),
        Triple("sheet-bindings", "selected", PrototypeScalar.Numeric(-1.0)),
        Triple("material-slider-chip-card", "volume", PrototypeScalar.Numeric(11.0)),
        Triple("material-slider-chip-card", "tue", PrototypeScalar.Text("wrong")),
        Triple("material-app-bar-dialog-pickers", "repeat", PrototypeScalar.Numeric(1.0)),
        Triple("fullscreen-all-nodes", "selected", PrototypeScalar.Numeric(-1.0)),
        Triple("fullscreen-all-nodes", "open", PrototypeScalar.Text("wrong")),
        Triple("material-app-bar-dialog-pickers", "upload", PrototypeScalar.Numeric(-1.0)),
        Triple("material-app-bar-dialog-pickers", "hour", PrototypeScalar.Numeric(24.0)),
        Triple("material-app-bar-dialog-pickers", "minute", PrototypeScalar.Numeric(60.0)),
        Triple("material-app-bar-dialog-pickers", "date", PrototypeScalar.Text("not-a-date")),
        Triple("material-app-bar-dialog-pickers", "editing", PrototypeScalar.Text("wrong")),
        Triple("material-app-bar-dialog-pickers", "saved", PrototypeScalar.Text("wrong")),
        Triple("repeat-state-keys", "liked_a", PrototypeScalar.Text("wrong")),
        Triple("secure-storage", "token", PrototypeScalar.Numeric(1.0)),
      )

    @BeforeAll
    @JvmStatic
    fun loadFixtures() {
      val directory =
        generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-spec/valid") }
          .first { it.isDirectory }
      fixtures =
        directory
          .listFiles()
          .orEmpty()
          .filter { it.extension == "json" }
          .sortedBy { it.name }
          .map { file ->
            val result = PrototypeSpecValidator.validate(file.readText())
            check(result is PrototypeSpecValidation.Success) { "$file: $result" }
            Fixture(
              file.nameWithoutExtension,
              result.spec,
              PrototypeSpecValidator.prepareStateWrites(result.spec, encoder),
            )
          }
    }
  }
}
