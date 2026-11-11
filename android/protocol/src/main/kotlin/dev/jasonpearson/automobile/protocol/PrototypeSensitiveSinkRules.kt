package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.callDefinition
import dev.jasonpearson.automobile.protocol.PrototypeSensitiveSinkIndex.Companion.overlaps
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.*

/** R2: sensitive call results and platform state cannot reach network or storage sinks. */
internal object PrototypeSensitiveSinkRules {
  private const val MAX_COPY_TAINT_CHECKS = 4_000_000
  private const val CHECK_MESSAGE = "Secure copy taint analysis exceeds 4000000 overlap checks"

  private data class Field(
    val text: String,
    val path: String,
    val pointerSource: String? = null,
    val itemBinding: Boolean = false,
    val stateKey: Boolean = false,
  ) {
    fun reached(
      texts: List<String>,
      rows: List<Pair<String, String>>,
      data: PrototypeSensitiveSinkIndex,
      platform: PrototypeSensitiveSinkIndex,
      state: PrototypeStateTaintIndex,
    ): Boolean {
      val stateRead =
        if (stateKey) texts.any(state::key) else pointerSource == null && texts.any(state::text)
      if (stateKey) return stateRead
      val rowRead = rows.any { (path, alias) ->
        this.path.startsWith("$path.children[") &&
          (itemBinding ||
            (pointerSource == null &&
              PrototypeRepeatTemplate.fieldReferences(text, alias).isNotEmpty()))
      }
      return rowRead ||
        stateRead ||
        reaches(texts, "data", data) ||
        reaches(texts, "platform", platform)
    }

    fun reaches(
      texts: List<String>,
      source: String,
      index: PrototypeSensitiveSinkIndex,
    ): Boolean {
      val pointers =
        if (pointerSource == null) texts.flatMap { PrototypeDataText.pointers(it, source) }
        else if (pointerSource == source) listOf(this.text) else emptyList()
      return pointers.any { index.overlaps(it, pointerSource == null) }
    }
  }

  fun errors(spec: JsonObject, context: PrototypeStateChecks.Context): List<PrototypeSpecError> =
    scan(spec, context).errors

  data class Scan(val errors: List<PrototypeSpecError>, val checks: Int)

  /** Counts sink trie-node visits, excluding construction and copy propagation. */
  fun scan(spec: JsonObject, context: PrototypeStateChecks.Context): Scan {
    val budget = PrototypeSensitiveSinkIndex.Budget(MAX_COPY_TAINT_CHECKS)
    val platformTaints = sensitivePlatformPointers(spec)
    val seeds = sensitiveDataPointers(spec, context)
    if (seeds.isEmpty() && platformTaints.isEmpty()) return Scan(emptyList(), budget.checks)
    val dataTaints =
      PrototypeCopyTaint.propagate(seeds, platformTaints, context, ::overlaps)
        ?: return Scan(
          listOf(
            PrototypeSpecError("$", CHECK_MESSAGE),
          ),
          budget.checks,
        )
    val dataIndex = PrototypeSensitiveSinkIndex(dataTaints.data, budget::visit)
    val platformIndex = PrototypeSensitiveSinkIndex(platformTaints, budget::visit)
    val stateIndex = PrototypeStateTaintIndex(dataTaints.state, budget::visit)
    val fields =
      sinkFields(spec, context)
        .filter { !it.stateKey || dataTaints.state.isNotEmpty() }
        .sortedBy { it.path }
    val validRepeats = PrototypeRepeatValidator.validate(spec) == null
    val scopes = if (validRepeats) PrototypeRepeatValidator.scopes(spec) else emptyList()
    budgetError(fields, scopes, validRepeats)?.let {
      return Scan(listOf(it), budget.checks)
    }
    val taintedRows = taintedRows(context, dataIndex)
    val errors =
      fields
        .filter { field ->
          if (budget.checks > MAX_COPY_TAINT_CHECKS) return@filter false
          field.reached(
            boundTexts(field, scopes, validRepeats),
            taintedRows,
            dataIndex,
            platformIndex,
            stateIndex,
          )
        }
        .map { field ->
          PrototypeSpecError(
            field.path,
            if (field.path.startsWith("storage.keys[")) "Sensitive value cannot be persisted"
            else "Sensitive value cannot be bound into a request",
          )
        }
    return Scan(
      if (budget.checks > MAX_COPY_TAINT_CHECKS) listOf(PrototypeSpecError("$", CHECK_MESSAGE))
      else errors,
      budget.checks,
    )
  }

  private fun sensitiveDataPointers(
    spec: JsonObject,
    context: PrototypeStateChecks.Context,
  ): List<String> =
    PrototypePlatformUses.uses(spec, context)
      .filterIsInstance<PrototypePlatformUses.Use.Call>()
      .filter { callDefinition(it.action.text("call"))?.second?.flag("sensitive") == true }
      .mapNotNull { it.action.text("into")?.let(PrototypeDataWriter::pathPointer) }

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
    index: PrototypeSensitiveSinkIndex,
  ): List<Pair<String, String>> =
    context.nodes.mapNotNull { node ->
      val repeat = node.value["repeat"] as? JsonObject
      val pointer = (repeat?.get("items") as? JsonObject)?.text("path")
      val alias = repeat?.text("as")
      if (alias != null && index.isTaintedPointer(pointer)) node.path to alias else null
    }

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

  private fun bindingFields(raw: JsonElement?, path: String, text: Boolean = false): List<Field> {
    val fields = mutableListOf<Field>()
    if (text && raw is JsonPrimitive && raw.isString) fields.add(Field(raw.content, path))
    val form = raw as? JsonObject ?: return fields
    form.text("state")?.let {
      fields.add(Field(it, "$path.state", stateKey = true))
      return fields
    }
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
      when (val parsed = PrototypeStorageKey.parse(key)) {
        is PrototypeStorageKey.Data ->
          fields.add(Field(parsed.pointer, "storage.keys[$index]", pointerSource = "data"))
        is PrototypeStorageKey.State ->
          fields.add(Field(parsed.key, "storage.keys[$index]", stateKey = true))
        null -> Unit
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
