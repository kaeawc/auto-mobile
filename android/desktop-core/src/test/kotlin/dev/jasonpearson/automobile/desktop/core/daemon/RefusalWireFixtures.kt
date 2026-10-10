package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * The typed refusals captured from the daemon's real serializers in `test/fixtures/refusal-wire/`
 * (`<code>.json` holds a `tools/call` result; `expectations.json` the fields a client must read).
 * Regenerate them at the repo root; never edit by hand.
 */
internal object RefusalWireFixtures {
  private const val FIXTURE_DIR = "test/fixtures/refusal-wire"

  private val dir: File by lazy {
    generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
      .map { File(it, FIXTURE_DIR) }
      .firstOrNull { it.isDirectory } ?: error("Could not locate $FIXTURE_DIR")
  }

  /** One captured refusal and the fields its expectation row says a client must decode. */
  class Case(val name: String, val result: JsonElement, private val fields: JsonObject) {
    val code: String = fields.getValue("code").jsonPrimitive.content
    val retryable: Boolean? = fields["retryable"]?.jsonPrimitive?.booleanOrNull
    val retryAfterMs: Long? = fields["retryAfterMs"]?.jsonPrimitive?.longOrNull
    val acquireNewSession: Boolean =
      fields["acquireNewSession"]?.jsonPrimitive?.booleanOrNull == true

    /** The JSON text the daemon put in the result's first content block. */
    val text: String
      get() =
        result.jsonObject
          .getValue("content")
          .jsonArray
          .first()
          .jsonObject
          .getValue("text")
          .jsonPrimitive
          .content

    val payload: JsonObject
      get() = DaemonJson.parseToJsonElement(text).jsonObject

    /**
     * The refusal's own message: `error.message` when nested, else the top-level `error` string.
     */
    val message: String?
      get() {
        val error = payload["error"]
        return (error as? JsonObject)?.get("message")?.jsonPrimitive?.contentOrNull
          ?: error?.takeIf { it !is JsonObject }?.jsonPrimitive?.contentOrNull
      }
  }

  fun case(name: String): Case = all().first { it.name == name }

  fun all(): List<Case> {
    val expectations =
      DaemonJson.parseToJsonElement(File(dir, "expectations.json").readText())
        .jsonObject
        .getValue("codes")
        .jsonObject
    return expectations.map { (name, row) ->
      val fixture = DaemonJson.parseToJsonElement(File(dir, "$name.json").readText()).jsonObject
      Case(name, fixture.getValue("result"), row.jsonObject.getValue("fields").jsonObject)
    }
  }
}
