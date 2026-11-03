package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.callDefinition
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.*

/** R2: sensitive call results and platform state cannot reach network or storage sinks. */
internal object PrototypeSensitiveSinkRules {
  private data class Field(
    val text: String,
    val path: String,
    val pointerSource: String? = null,
    val itemBinding: Boolean = false,
  ) {
    fun reaches(
      texts: List<String>,
      source: String,
      taints: List<String>,
    ): Boolean {
      val pointers =
        if (pointerSource == null) texts.flatMap { PrototypeDataText.pointers(it, source) }
        else if (pointerSource == source) listOf(this.text) else emptyList()
      return pointers.any { pointer ->
        taints.any { PrototypeSensitiveSinkRules.overlaps(it, pointer, pointerSource == null) }
      }
    }
  }

  fun errors(spec: JsonObject, context: PrototypeStateChecks.Context): List<PrototypeSpecError> {
    val platformTaints = sensitivePlatformPointers(spec)
    val seeds = sensitiveDataPointers(spec, context)
    if (seeds.isEmpty() && platformTaints.isEmpty()) return emptyList()
    val dataTaints = propagateCopies(seeds, platformTaints, context)
    val fields = sinkFields(spec, context).sortedBy { it.path }
    val validRepeats = PrototypeRepeatValidator.validate(spec) == null
    val scopes = if (validRepeats) PrototypeRepeatValidator.scopes(spec) else emptyList()
    budgetError(fields, scopes, validRepeats)?.let {
      return listOf(it)
    }
    val taintedRows = taintedRows(context, dataTaints)
    return fields
      .filter { field ->
        val rowRead = taintedRows.any { (path, alias) ->
          field.path.startsWith("$path.children[") &&
            (field.itemBinding ||
              (field.pointerSource == null &&
                PrototypeRepeatTemplate.fieldReferences(field.text, alias).isNotEmpty()))
        }
        val texts = boundTexts(field, scopes, validRepeats)
        rowRead ||
          field.reaches(texts, "data", dataTaints) ||
          field.reaches(texts, "platform", platformTaints)
      }
      .map { field ->
        PrototypeSpecError(
          field.path,
          if (field.path.startsWith("storage.keys[")) "Sensitive value cannot be persisted"
          else "Sensitive value cannot be bound into a request",
        )
      }
  }

  private fun sensitiveDataPointers(
    spec: JsonObject,
    context: PrototypeStateChecks.Context,
  ): List<String> =
    PrototypePlatformUses.uses(spec, context)
      .filterIsInstance<PrototypePlatformUses.Use.Call>()
      .filter { callDefinition(it.action.text("call"))?.second?.flag("sensitive") == true }
      .mapNotNull { it.action.text("into")?.let(PrototypeDataWriter::pathPointer) }

  /** A data action copying a tainted read into `/data` taints its destination, transitively. */
  private fun propagateCopies(
    seeds: List<String>,
    platformTaints: List<String>,
    context: PrototypeStateChecks.Context,
  ): List<String> {
    val copies =
      context.actions
        .filter { it.value.text("type") in DATA_WRITES }
        .mapNotNull { action ->
          val into = action.value.text("path")?.let(PrototypeDataWriter::pathPointer)
          val read = action.value["value"] as? JsonObject
          val data = read?.text("data")
          val platform = read?.text("platform")
          when {
            into == null -> null
            data != null -> Triple(into, "data", data)
            platform != null -> Triple(into, "platform", platform)
            else -> null
          }
        }
    val taints = seeds.toMutableList()
    do {
      val added = copies.filter { (into, source, from) ->
        into !in taints &&
          (if (source == "data") taints else platformTaints).any { overlaps(it, from, false) }
      }
      taints.addAll(added.map { it.first }.distinct())
    } while (added.isNotEmpty())
    return taints
  }

  private val DATA_WRITES = setOf("setData", "appendData", "prependData", "upsertData")

  private fun sensitivePlatformPointers(spec: JsonObject): List<String> {
    val declared =
      ((spec["requires"] as? JsonObject)?.get("platform") as? JsonArray)
        .orEmpty()
        .mapNotNull { (it as? JsonPrimitive)?.content }
        .toSet()
    return PrototypeSpecContract.contract
      .getValue("platformModules")
      .jsonObject
      .filterKeys { it in declared }
      .flatMap { (module, raw) ->
        (raw.jsonObject["state"] as? JsonObject).orEmpty().mapNotNull { (key, entry) ->
          if (entry.jsonObject.flag("sensitive")) "/$module/$key" else null
        }
      }
  }

  private fun budgetError(
    fields: List<Field>,
    scopes: List<PrototypeRepeatValidator.Scope>,
    validRepeats: Boolean,
  ): PrototypeSpecError? {
    if (!validRepeats) return null
    var bytes = 0L
    for (field in fields) {
      val scope = scopes.firstOrNull { field.path.startsWith("${it.path}.children[") }
      bytes +=
        field.text.toByteArray(Charsets.UTF_8).size.toLong() * maxOf(1, scope?.items?.size ?: 1)
      if (bytes > 4194304)
        return PrototypeSpecError(
          field.path,
          "Secure binding scan exceeds 4194304 expanded UTF-8 bytes",
        )
    }
    return null
  }

  private fun taintedRows(
    context: PrototypeStateChecks.Context,
    taints: List<String>,
  ): List<Pair<String, String>> =
    context.nodes.mapNotNull { node ->
      val repeat = node.value["repeat"] as? JsonObject
      val pointer = (repeat?.get("items") as? JsonObject)?.text("path")
      val alias = repeat?.text("as")
      if (alias != null && isTaintedPointer(pointer, taints)) node.path to alias else null
    }

  private fun isTaintedPointer(pointer: String?, taints: List<String>): Boolean =
    pointer != null &&
      PrototypeDataPointer.isValid(pointer) &&
      taints.any { overlaps(it, pointer, false) }

  private fun boundTexts(
    field: Field,
    scopes: List<PrototypeRepeatValidator.Scope>,
    validRepeats: Boolean,
  ): List<String> {
    // Typed pointers stay literal. Derived fields have no instances, so retain authored text.
    if (field.pointerSource != null || !validRepeats) return listOf(field.text)
    return PrototypeRepeatValidator.keyInstances(
        scopes,
        buildJsonObject { put("stateKey", field.text) },
        field.path,
      )
      .mapNotNull { (value, _) -> value.text("stateKey") }
      .ifEmpty { listOf(field.text) }
  }

  private fun overlaps(taint: String, pointer: String, pointerIndexWildcard: Boolean): Boolean =
    taint.drop(1).split('/').zip(pointer.drop(1).split('/')).all { (left, right) ->
      left == right || left == "{index}" || (pointerIndexWildcard && right == "{index}")
    }

  private fun bindingFields(raw: JsonElement?, path: String, text: Boolean = false): List<Field> {
    val fields = mutableListOf<Field>()
    if (text && raw is JsonPrimitive && raw.isString) fields.add(Field(raw.content, path))
    val form = raw as? JsonObject ?: return fields
    if ("state" in form) return fields
    for (source in listOf("data", "platform")) {
      form.text(source)?.let { fields.add(Field(it, path, pointerSource = source)) }
    }
    if (form.text("item") != null) fields.add(Field("", path, itemBinding = true))
    return fields
  }

  private fun sinkFields(spec: JsonObject, context: PrototypeStateChecks.Context): List<Field> {
    val fields = mutableListOf<Field>()
    for (action in context.actions.filter { it.value.text("type") == "request" }) {
      PrototypeBindableFields.firstAction<Boolean>(action.value, action.path) { raw, path, kind ->
        if (inRequest(path, action.path)) {
          if (kind == PrototypeBindableKind.REQUEST_TEXT)
            fields.addAll(bindingFields(raw, path, text = true))
          else if (kind == PrototypeBindableKind.EMIT_BINDING)
            fields.addAll(bindingFields(raw, path))
        }
        null
      }
    }
    for ((id, raw) in (spec["channels"] as? JsonObject).orEmpty()) {
      val channel = raw.jsonObject
      val at = PrototypeValidationPaths.keyPath("channels", id)
      fields.addAll(bindingFields(channel["url"], "$at.url", text = true))
      for ((name, value) in (channel["headers"] as? JsonObject).orEmpty()) {
        fields.addAll(
          bindingFields(value, PrototypeValidationPaths.keyPath("$at.headers", name), text = true),
        )
      }
    }
    ((spec["storage"] as? JsonObject)?.get("keys") as? JsonArray).orEmpty().forEachIndexed {
      index,
      raw ->
      val key = (raw as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
      if (key.startsWith("data:") && PrototypeDataPointer.isValid(key.drop(5))) {
        fields.add(Field(key.drop(5), "storage.keys[$index]", pointerSource = "data"))
      }
    }
    return fields.distinctBy { it.path }
  }

  private fun inRequest(path: String, at: String): Boolean =
    path == "$at.url" ||
      path == "$at.body" ||
      path.startsWith("$at.body.") ||
      listOf("headers", "query").any { path.startsWith("$at.$it.") || path.startsWith("$at.$it[") }
}
