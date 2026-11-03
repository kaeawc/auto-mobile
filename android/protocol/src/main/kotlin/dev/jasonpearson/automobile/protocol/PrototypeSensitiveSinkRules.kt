package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Library-only R2 data flow (#15635), matching TypeScript's `prototypeSensitiveSinkErrors` and
 * Swift's `PrototypeSensitiveSinkRules`: a `/data` pointer written by a `sensitive` platform call
 * may not reach a request or channel wire field. Literal `{value}` payloads stay opaque.
 */
internal object PrototypeSensitiveSinkRules {
  const val MESSAGE = "Sensitive value cannot be bound into a request"
  private const val BUDGET_BYTES = 4_194_304L

  private data class Field(
    val text: String,
    val path: String,
    val dataPointer: Boolean = false,
    val itemBinding: Boolean = false,
  )

  fun error(spec: JsonObject, context: PrototypeStateChecks.Context): PrototypeSpecError? =
    errors(spec, context).firstOrNull()

  /** Every sink path in authored path order; strict validation has already accepted repeats. */
  fun errors(spec: JsonObject, context: PrototypeStateChecks.Context): List<PrototypeSpecError> {
    val taints = sensitivePointers(spec, context)
    if (taints.isEmpty()) return emptyList()
    val sinks = sinkFields(spec, context).sortedBy { it.path }
    val scopes = PrototypeRepeatValidator.scopes(spec)
    budgetError(sinks, scopes)?.let {
      return listOf(it)
    }
    // Data-backed rows are rebuilt from live data, so any read of a tainted row is a sink.
    val taintedRows =
      context.nodes.mapNotNull { node ->
        val repeat = node.value["repeat"] as? JsonObject
        val alias = repeat?.text("as")
        val pointer = repeat?.member("items")?.text("path")
        if (
          alias != null &&
            pointer != null &&
            PrototypeDataPointer.isValid(pointer) &&
            taints.any { overlaps(it, pointer, pointerIndexWildcard = false) }
        )
          node.path to alias
        else null
      }
    return sinks
      .filter { field -> readsTaintedRow(field, taintedRows) || reaches(field, scopes, taints) }
      .map { PrototypeSpecError(it.path, MESSAGE) }
  }

  private fun budgetError(
    sinks: List<Field>,
    scopes: List<PrototypeRepeatValidator.Scope>,
  ): PrototypeSpecError? {
    var bytes = 0L
    for (field in sinks) {
      val scope = scopes.firstOrNull { field.path.startsWith("${it.path}.children[") }
      bytes +=
        field.text.toByteArray(Charsets.UTF_8).size.toLong() * maxOf(1, scope?.items?.size ?: 1)
      if (bytes > BUDGET_BYTES)
        return PrototypeSpecError(
          field.path,
          "Secure binding scan exceeds 4194304 expanded UTF-8 bytes",
        )
    }
    return null
  }

  private fun readsTaintedRow(field: Field, rows: List<Pair<String, String>>): Boolean =
    rows.any { (path, alias) ->
      field.path.startsWith("$path.children[") &&
        (field.itemBinding ||
          (!field.dataPointer &&
            PrototypeRepeatTemplate.fieldReferences(field.text, alias).isNotEmpty()))
    }

  private fun reaches(
    field: Field,
    scopes: List<PrototypeRepeatValidator.Scope>,
    taints: List<String>,
  ): Boolean {
    // Typed pointers are literal at runtime. Derived text has no host-side instance, so an
    // empty binding falls back to the authored data placeholders.
    val pointers =
      if (field.dataPointer) listOf(field.text)
      else
        PrototypeRepeatValidator.keyInstances(
            scopes,
            JsonObject(mapOf("stateKey" to JsonPrimitive(field.text))),
            field.path,
          )
          .mapNotNull { (value, _) -> value.text("stateKey") }
          .ifEmpty { listOf(field.text) }
          .flatMap(PrototypeDataText::pointers)
    return pointers.any { pointer ->
      taints.any { overlaps(it, pointer, pointerIndexWildcard = !field.dataPointer) }
    }
  }

  private fun sinkFields(spec: JsonObject, context: PrototypeStateChecks.Context): List<Field> {
    val fields = mutableListOf<Field>()
    fun binding(raw: JsonElement?, path: String, text: Boolean = false) {
      if (text && raw is JsonPrimitive && raw.isString) fields.add(Field(raw.content, path))
      val form = raw as? JsonObject ?: return
      if (form.containsKey("state")) return
      form.text("data")?.let { fields.add(Field(it, path, dataPointer = true)) }
      if (form.text("item") != null) fields.add(Field("", path, itemBinding = true))
    }
    fun entries(raw: JsonElement?, path: String, text: Boolean) {
      for ((name, value) in (raw as? JsonObject).orEmpty()) {
        binding(value, keyPath(path, name), text)
      }
    }
    for (action in context.actions) {
      val value = action.value
      if (value.text("type") != "request") continue
      val at = action.path
      binding(value["url"], "$at.url", text = true)
      entries(value["headers"], "$at.headers", text = true)
      entries(value["query"], "$at.query", text = true)
      val body = value["body"] as? JsonObject
      val parts = body?.get("multipart") as? JsonArray
      when {
        parts != null ->
          parts.forEachIndexed { index, part ->
            binding((part as? JsonObject)?.get("value"), "$at.body.multipart[$index].value")
          }
        body?.get("form") is JsonObject -> entries(body["form"], "$at.body.form", text = false)
        body?.get("file") == null -> binding(value["body"], "$at.body")
      }
    }
    for ((id, raw) in (spec["channels"] as? JsonObject).orEmpty()) {
      val at = keyPath("channels", id)
      val channel = raw as? JsonObject
      binding(channel?.get("url"), "$at.url", text = true)
      entries(channel?.get("headers"), "$at.headers", text = true)
    }
    return fields
  }

  /** The `/data` pointers written by the `into` of every `sensitive` call, in authored order. */
  private fun sensitivePointers(
    spec: JsonObject,
    context: PrototypeStateChecks.Context,
  ): List<String> =
    PrototypePlatformUses.uses(spec, context)
      .filterIsInstance<PrototypePlatformUses.Use.Call>()
      .filter {
        PrototypePlatformModules.callDefinition(it.action.text("call"))
          ?.second
          ?.flag("sensitive") == true
      }
      .mapNotNull { use -> use.action.text("into")?.let(PrototypeDataWriter::pathPointer) }

  /**
   * Segment-wise prefix overlap: binding a parent carries its sensitive member. A `{index}` taint
   * segment stands for any row; text sinks also keep `{index}` they could not expand.
   */
  private fun overlaps(taint: String, pointer: String, pointerIndexWildcard: Boolean): Boolean {
    val left = taint.substring(1).split('/')
    val right = pointer.substring(1).split('/')
    return left.zip(right).all { (taintSegment, segment) ->
      taintSegment == segment ||
        taintSegment == "{index}" ||
        (pointerIndexWildcard && segment == "{index}")
    }
  }
}
