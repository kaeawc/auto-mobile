package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.fixtureFile
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/**
 * Runs the shared action traces (#16456) in `test/fixtures/prototype-spec/action-traces/` on the
 * Android runtime: each step runs one tap's actions or advances the fake clock, then the state,
 * `/data`, stack paths, pager pages and shown flag it names are compared. A trace listed under
 * `kotlin` in `action-trace-skips.json` must still fail here, so a fixed gap shrinks the list.
 */
class PrototypeActionTracesTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }

    private val traces: List<JsonObject> =
      fixtureFile("prototype-spec/action-traces")
        .listFiles { file -> file.extension == "json" }!!
        .sortedBy { it.name }
        .flatMap {
          Json.parseToJsonElement(it.readText()).jsonArray.map { trace -> trace.jsonObject }
        }

    private val skipped: Set<String> =
      Json.parseToJsonElement(fixtureFile("prototype-spec/action-trace-skips.json").readText())
        .jsonObject
        .getValue("kotlin")
        .jsonArray
        .map { it.jsonObject.getValue("trace").jsonPrimitive.content }
        .toSet()

    private val json = Json { classDiscriminator = "type" }
  }

  @Test
  fun `every trace runs on the Android runtime unless skipped`() = runTest {
    val failures =
      traces.mapNotNull { trace -> runTrace(trace)?.let { trace.name() to it } }.toMap()
    val unexpected = failures.filterKeys { it !in skipped }
    assertTrue("Traces failed on Android: $unexpected", unexpected.isEmpty())
    val stale = skipped.filter { it !in failures }
    assertTrue("Skipped traces now pass; remove them from the skip list: $stale", stale.isEmpty())
  }

  private fun JsonObject.name() = getValue("name").jsonPrimitive.content

  /** The first mismatch, or null when every step matched. */
  private suspend fun TestScope.runTrace(trace: JsonObject): String? {
    val validation = PrototypeSpecValidator.validate(trace.getValue("spec").toString())
    val spec =
      (validation as? PrototypeSpecValidation.Success)?.spec ?: return "spec refused: $validation"
    val runtime =
      PrototypeRuntime(
        spec,
        clock = { testScheduler.currentTime },
        nextSequence = { 0L },
        warn = {},
        requestScope = backgroundScope,
      )
    runtime.shown()
    try {
      for ((index, raw) in trace.getValue("steps").jsonArray.withIndex()) {
        val step = raw.jsonObject
        val actions = step["actions"]?.jsonArray
        if (actions != null) {
          runtime.handle(
            PrototypeInteraction.Tap(
              actions.map { json.decodeFromJsonElement(PrototypeAction.serializer(), it) },
            ),
          )
        } else {
          runtime.advanceClock(step.getValue("advanceMs").jsonPrimitive.int)
        }
        mismatch(runtime.current, step.getValue("expect").jsonObject)?.let {
          return "step $index: $it"
        }
      }
    } catch (error: RuntimeException) {
      return "threw ${error::class.simpleName}: ${error.message}"
    } finally {
      runtime.close()
    }
    return null
  }

  private fun mismatch(snapshot: PrototypeRuntimeSnapshot, expected: JsonObject): String? {
    val actual =
      mapOf(
        "state" to
          JsonObject(
            snapshot.state.mapValues {
              json.encodeToJsonElement(PrototypeScalar.serializer(), it.value)
            },
          ),
        "data" to (snapshot.spec.data ?: JsonObject(emptyMap())),
        "stacks" to
          JsonObject(
            snapshot.stacks.mapValues { (_, stack) ->
              JsonArray(stack.path.map { JsonPrimitive(it) })
            },
          ),
        "pages" to JsonObject(snapshot.pages.mapValues { JsonPrimitive(it.value) }),
        "shown" to JsonPrimitive(snapshot.active),
      )
    return expected.entries.firstNotNullOfOrNull { (key, value) ->
      val got = actual.getValue(key)
      if (normalized(got) == normalized(value)) null else "$key expected $value, got $got"
    }
  }

  /** JSON numbers compare by value, so `1` and `1.0` match as on the other platforms. */
  private fun normalized(element: JsonElement): Any? =
    when (element) {
      is JsonNull -> null
      is JsonObject -> element.mapValues { normalized(it.value) }
      is JsonArray -> element.map(::normalized)
      is JsonPrimitive ->
        if (element.isString) element.content
        else element.booleanOrNull ?: element.doubleOrNull ?: element.content
    }
}
