package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.TraversalOrderResult
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceChangeEvent
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceEntry
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceFileInfo
import dev.jasonpearson.automobile.ctrlproxy.storage.buildStorageChangedMessage
import dev.jasonpearson.automobile.ctrlproxy.storage.storageChangeType
import dev.jasonpearson.automobile.protocol.TraversalOrderData
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the last typed frames of #11877 (storage, focus, highlight and hierarchy) to the bytes the
 * hand-built frames wrote. The `legacy*` functions are the previous builders kept verbatim as the
 * oracle, so every case compares full frame text. One case differs by design and is asserted
 * separately: a found preference whose value is null (SharedPreferences cannot store one).
 */
class StorageFocusFramesGoldenTest {
  private val json = Json {
    prettyPrint = false
    encodeDefaults = true
  }

  private val ts = 1_700_000_000_000L
  private val requestIds = listOf(null, "req-1", "q\"uo\\te")
  private val errors = listOf(null, "boom \"q\" \n é")
  private val perfs: List<JsonElement?> =
    listOf(null, Json.parseToJsonElement("""{"total":50,"steps":[1,2]}"""))

  private fun StringBuilder.field(name: String, value: String) {
    append(',')
    append(json.encodeToString(name))
    append(':')
    append(json.encodeToString(value))
  }

  // ---- storage results: the old StorageResponses builders ----

  private fun legacyPreferenceFiles(
    requestId: String?,
    packageName: String,
    files: List<PreferenceFileInfo>?,
    error: String?,
  ) = buildString {
    append("""{"type":"preference_files","timestamp":$ts""")
    if (requestId != null) field("requestId", requestId)
    append(""","packageName":${json.encodeToString(packageName)}""")
    if (files != null) {
      append(""","success":true,"files":${json.encodeToString(files)}""")
    } else {
      append(""","success":false,"error":${json.encodeToString(error ?: "Unknown error")}""")
    }
    append("}")
  }

  private fun legacyPreferences(
    target: StorageTarget,
    entries: List<PreferenceEntry>?,
    error: String?,
  ) = buildString {
    append("""{"type":"preferences","timestamp":$ts""")
    if (target.requestId != null) field("requestId", target.requestId)
    append(""","packageName":${json.encodeToString(target.packageName)}""")
    append(""","fileName":${json.encodeToString(target.fileName)}""")
    if (entries != null) {
      append(""","success":true,"entries":${json.encodeToString(entries)}""")
    } else {
      append(""","success":false,"error":${json.encodeToString(error ?: "Unknown error")}""")
    }
    append("}")
  }

  private fun legacySubscribe(target: StorageTarget, subscriptionId: String?, error: String?) =
    buildString {
      append("""{"type":"subscribe_storage_result","timestamp":$ts""")
      if (target.requestId != null) field("requestId", target.requestId)
      append(""","packageName":${json.encodeToString(target.packageName)}""")
      append(""","fileName":${json.encodeToString(target.fileName)}""")
      if (subscriptionId != null) {
        append(""","success":true,"subscriptionId":${json.encodeToString(subscriptionId)}""")
      } else {
        append(""","success":false,"error":${json.encodeToString(error ?: "Unknown error")}""")
      }
      append("}")
    }

  private fun legacyUnsubscribe(target: StorageTarget, success: Boolean) = buildString {
    append("""{"type":"unsubscribe_storage_result","timestamp":$ts""")
    if (target.requestId != null) field("requestId", target.requestId)
    append(""","packageName":${json.encodeToString(target.packageName)}""")
    append(""","fileName":${json.encodeToString(target.fileName)}""")
    append(""","success":$success""")
    append("}")
  }

  private fun legacyGetPreference(outcome: GetPreferenceOutcome) = buildString {
    append("""{"type":"get_preference_result","timestamp":$ts""")
    if (outcome.requestId != null) field("requestId", outcome.requestId)
    append(""","packageName":${json.encodeToString(outcome.packageName)}""")
    append(""","fileName":${json.encodeToString(outcome.fileName)}""")
    append(""","key":${json.encodeToString(outcome.key)}""")
    if (outcome.error != null) {
      append(""","success":false,"found":false,"error":${json.encodeToString(outcome.error)}""")
    } else if (outcome.entry != null) {
      append(""","success":true,"found":true""")
      if (outcome.entry.value != null) {
        append(""","value":${json.encodeToString(outcome.entry.value)}""")
      } else {
        append(""","value":null""")
      }
      append(""","valueType":${json.encodeToString(outcome.entry.type)}""")
    } else {
      append(""","success":true,"found":false""")
    }
    append("}")
  }

  private fun legacyKeyed(type: String, target: StorageTarget, key: String?, error: String?) =
    buildString {
      append("""{"type":"$type","timestamp":$ts""")
      if (target.requestId != null) field("requestId", target.requestId)
      append(""","packageName":${json.encodeToString(target.packageName)}""")
      append(""","fileName":${json.encodeToString(target.fileName)}""")
      if (key != null) append(""","key":${json.encodeToString(key)}""")
      if (error != null) {
        append(""","success":false,"error":${json.encodeToString(error)}""")
      } else {
        append(""","success":true""")
      }
      append("}")
    }

  private val targets = requestIds.map { StorageTarget(it, "com.example", "prefs \"1\"") }

  @Test
  fun `preference files frames match the hand-built bytes`() {
    val fileLists = listOf(null, emptyList(), listOf(PreferenceFileInfo("p", "/data/p.xml", 3)))
    for (id in requestIds) for (files in fileLists) for (err in errors) {
      assertEquals(
        legacyPreferenceFiles(id, "com.example", files, err),
        preferenceFilesResultFrame(ts, id, "com.example", files, err),
      )
    }
  }

  @Test
  fun `preferences frames match the hand-built bytes`() {
    val entryLists =
      listOf(
        null,
        listOf(PreferenceEntry("k", "\"v\"", "STRING"), PreferenceEntry("n", null, "STRING")),
      )
    for (target in targets) for (entries in entryLists) for (err in errors) {
      assertEquals(
        legacyPreferences(target, entries, err),
        preferencesResultFrame(ts, target, entries, err),
      )
    }
  }

  @Test
  fun `subscribe and unsubscribe frames match the hand-built bytes`() {
    for (target in targets) {
      for (subscriptionId in listOf(null, "com.example:prefs")) for (err in errors) {
        assertEquals(
          legacySubscribe(target, subscriptionId, err),
          subscribeStorageResultFrame(ts, target, subscriptionId, err),
        )
      }
      for (success in listOf(true, false)) {
        assertEquals(
          legacyUnsubscribe(target, success),
          unsubscribeStorageResultFrame(ts, target, success),
        )
      }
    }
  }

  @Test
  fun `get preference frames match the hand-built bytes`() {
    val entries = listOf(null, PreferenceEntry("k", "42", "INT"))
    for (target in targets) for (entry in entries) for (err in errors) {
      val outcome =
        GetPreferenceOutcome(target.requestId, target.packageName, target.fileName, "k", entry, err)
      assertEquals(legacyGetPreference(outcome), getPreferenceResultFrame(ts, outcome))
    }
  }

  @Test
  fun `a found preference with a null value omits value instead of writing null`() {
    val outcome =
      GetPreferenceOutcome(
        "r",
        "com.example",
        "prefs",
        "k",
        PreferenceEntry("k", null, "STRING"),
        null,
      )
    assertEquals(
      legacyGetPreference(outcome).replace(""","value":null""", ""),
      getPreferenceResultFrame(ts, outcome),
    )
  }

  @Test
  fun `set remove and clear frames match the hand-built bytes`() {
    for (target in targets) for (err in errors) {
      assertEquals(
        legacyKeyed("set_preference_result", target, "k", err),
        setPreferenceResultFrame(ts, target, "k", err),
      )
      assertEquals(
        legacyKeyed("remove_preference_result", target, "k", err),
        removePreferenceResultFrame(ts, target, "k", err),
      )
      assertEquals(
        legacyKeyed("clear_preferences_result", target, null, err),
        clearPreferencesResultFrame(ts, target, err),
      )
    }
  }

  // ---- storage_changed: the old buildStorageChangedMessage ----

  private fun legacyTypedValue(value: String?, type: String?): String {
    if (value == null) return "null"
    val quoted =
      type == "STRING" ||
        type == "LONG" ||
        (type == "FLOAT" && value.toDoubleOrNull()?.isFinite() != true)
    return if (quoted) json.encodeToString(value) else value
  }

  private fun legacyStorageChanged(event: PreferenceChangeEvent) = buildString {
    append("""{"type":"storage_changed","timestamp":$ts""")
    append(""","packageName":${json.encodeToString(event.packageName)}""")
    append(""","fileName":${json.encodeToString(event.fileName)}""")
    if (event.key != null) {
      append(""","key":${json.encodeToString(event.key)}""")
    } else {
      append(""","key":null""")
    }
    append(""","value":${legacyTypedValue(event.value, event.type)}""")
    append(""","valueType":${json.encodeToString(event.type)}""")
    storageChangeType(event)?.let { append(""","changeType":${json.encodeToString(it)}""") }
    if (event.previousValueType != null) {
      append(
        ""","previousValue":${legacyTypedValue(event.previousValue, event.previousValueType)}""",
      )
    }
    append(""","eventTimestamp":${event.timestamp}""")
    append(""","sequenceNumber":${event.sequenceNumber}""")
    append("}")
  }

  @Test
  fun `storage changed frames match the hand-built bytes`() {
    val values =
      listOf(
        null to "UNKNOWN",
        "dark \"mode\"" to "STRING",
        "null" to "STRING",
        "9007199254740993" to "LONG",
        "42" to "INT",
        "1.5" to "FLOAT",
        "NaN" to "FLOAT",
        "true" to "BOOLEAN",
        """["a","b"]""" to "STRING_SET",
      )
    val previous = listOf(null to null, null to "UNKNOWN", "light" to "STRING", "7" to "INT")
    for ((value, type) in values) for ((prior, priorType) in previous) for (key in
      listOf(null, "theme")) {
      val event =
        PreferenceChangeEvent(
          packageName = "com.example",
          fileName = "prefs.xml",
          key = key,
          value = value,
          type = type,
          timestamp = 222L,
          sequenceNumber = 3L,
          previousValue = prior,
          previousValueType = priorType,
        )
      assertEquals(
        "value=$value/$type prior=$prior/$priorType key=$key",
        legacyStorageChanged(event),
        buildStorageChangedMessage(event, ts),
      )
    }
  }

  // ---- focus, traversal, highlight and hierarchy ----

  private val element = UIElementInfo(text = "OK \"go\"", resourceId = "id/ok", clickable = "true")

  private fun legacyHighlight(
    requestId: String?,
    success: Boolean,
    error: String?,
    perf: JsonElement?,
  ) = buildString {
    append("""{"type":"highlight_response","timestamp":$ts""")
    if (requestId != null) field("requestId", requestId)
    append(""","success":$success""")
    append(""","error":${json.encodeToString<String?>(error)}""")
    if (perf != null) append(""","perfTiming":$perf""")
    append("}")
  }

  private fun legacyCurrentFocus(
    requestId: String?,
    focused: UIElementInfo?,
    perf: JsonElement?,
  ) = buildString {
    append("""{"type":"current_focus_result","timestamp":$ts""")
    if (requestId != null) field("requestId", requestId)
    append(""","totalTimeMs":12""")
    if (focused != null) {
      append(""","focusedElement":${json.encodeToString(serializer<UIElementInfo>(), focused)}""")
    } else {
      append(""","focusedElement":null""")
    }
    if (perf != null) append(""","perfTiming":$perf""")
    append("}")
  }

  private fun legacyTraversal(
    requestId: String?,
    result: TraversalOrderResult,
    perf: JsonElement?,
  ) = buildString {
    append("""{"type":"traversal_order_result","timestamp":$ts""")
    if (requestId != null) field("requestId", requestId)
    append(""","totalTimeMs":12""")
    append(""","result":${json.encodeToString(serializer<TraversalOrderResult>(), result)}""")
    if (perf != null) append(""","perfTiming":$perf""")
    append("}")
  }

  private fun legacyHierarchy(
    data: String,
    requestId: String?,
    frameContext: String?,
    perf: JsonElement?,
  ) = buildString {
    append("""{"type":"hierarchy_update","timestamp":$ts,"data":$data""")
    if (requestId != null) field("requestId", requestId)
    if (frameContext != null) field("frameContext", frameContext)
    if (perf != null) append(""","perfTiming":$perf""")
    append("}")
  }

  @Test
  fun `highlight frames match the hand-built bytes`() {
    for (id in requestIds) for (err in errors) for (perf in perfs) for (success in
      listOf(true, false)) {
      assertEquals(
        legacyHighlight(id, success, err, perf),
        highlightResponseFrame(ts, id, success, err, perf),
      )
    }
  }

  @Test
  fun `current focus success frames match the hand-built bytes`() {
    for (id in requestIds) for (focused in listOf(null, element)) for (perf in perfs) {
      val elementJson = focused?.let { json.encodeToString(serializer<UIElementInfo>(), it) }
      assertEquals(
        legacyCurrentFocus(id, focused, perf),
        currentFocusResultFrame(ts, id, 12L, elementJson, perf),
      )
    }
  }

  @Test
  fun `traversal order success frames match the hand-built bytes`() {
    val results =
      listOf(
        TraversalOrderResult(elements = emptyList()),
        TraversalOrderResult(
          elements = listOf(element, element.copy(text = "B")),
          focusedIndex = 1,
        ),
        TraversalOrderResult(
          elements = listOf(element),
          truncationReasons = listOf("max_children"),
        ),
      )
    for (id in requestIds) for (result in results) for (perf in perfs) {
      val data =
        TraversalOrderData(
          elements = result.elements.map { json.encodeToString(serializer<UIElementInfo>(), it) },
          focusedIndex = result.focusedIndex,
          totalCount = result.totalCount,
          truncationReasons = result.truncationReasons,
        )
      assertEquals(
        legacyTraversal(id, result, perf),
        traversalOrderResultFrame(ts, id, 12L, data, perf),
      )
    }
  }

  @Test
  fun `hierarchy update frames match the hand-built bytes`() {
    val data = """{"packageName":"com.example","hierarchy":{"text":"a\"b","children":[]}}"""
    for (id in requestIds) for (context in listOf(null, "frame \"1\"")) for (perf in perfs) {
      assertEquals(
        legacyHierarchy(data, id, context, perf),
        hierarchyUpdateFrame(ts, data, id, context, perf),
      )
    }
  }
}
