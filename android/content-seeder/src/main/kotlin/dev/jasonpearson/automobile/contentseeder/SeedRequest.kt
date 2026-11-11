package dev.jasonpearson.automobile.contentseeder

import org.json.JSONArray
import org.json.JSONException

sealed interface SeedRequest {
  val namespace: String

  data class Account(override val namespace: String) : SeedRequest

  data class CalendarBatch(override val namespace: String, val items: List<CalendarEvent>) :
    SeedRequest

  data class SmsBatch(override val namespace: String, val items: List<SmsMessage>) : SeedRequest

  data class Reset(
    override val namespace: String,
    val kinds: Set<String>,
    val dropAccount: Boolean = false,
  ) : SeedRequest

  data class CalendarEvent(
    val title: String,
    val startMillis: Long,
    val endMillis: Long,
    val allDay: Boolean,
    val location: String?,
    val calendar: String,
  )

  data class SmsMessage(
    val address: String,
    val body: String,
    val dateMillis: Long,
    val read: Boolean,
  )
}

sealed interface SeedParseResult {
  data class Valid(val request: SeedRequest) : SeedParseResult

  data class Invalid(val message: String) : SeedParseResult
}

/** Inject the Android-owned JSON boundary so protocol validation stays JVM-only. */
fun interface SeedItemsReader {
  fun read(json: String): List<Map<String, Any?>>
}

private val androidItemsReader = SeedItemsReader { json ->
  val items = JSONArray(json)
  (0 until items.length()).map { index ->
    val item = items.getJSONObject(index)
    item.keys().asSequence().associateWith { key -> item.get(key) }
  }
}

/** String extras carry a namespace and an items JSON array or comma-separated reset kinds. */
fun parseSeedRequest(
  parameters: Map<String, String?>,
  itemsReader: SeedItemsReader = androidItemsReader,
): SeedParseResult {
  val namespace = parameters["namespace"]
  if (namespace == null || !namespace.matches(Regex("^[A-Za-z0-9_-]{1,32}$"))) {
    return SeedParseResult.Invalid("namespace must match ^[A-Za-z0-9_-]{1,32}$")
  }
  return try {
    SeedParseResult.Valid(parseBatch(parameters, namespace, itemsReader))
  } catch (error: JSONException) {
    SeedParseResult.Invalid("Invalid items JSON: ${error.message}")
  } catch (error: IllegalArgumentException) {
    SeedParseResult.Invalid(error.message ?: "Invalid seed request")
  }
}

private fun parseBatch(
  parameters: Map<String, String?>,
  namespace: String,
  reader: SeedItemsReader,
): SeedRequest {
  val kind = parameters["kind"]
  if (kind == "account") return SeedRequest.Account(namespace)
  if (kind == "reset") {
    val dropAccount =
      parameters["dropAccount"]?.let {
        requireNotNull(it.toBooleanStrictOrNull()) { "dropAccount must be true or false" }
      } ?: false
    val kinds = parameters["kinds"]?.split(",")?.toSet() ?: emptySet()
    require((kinds.isNotEmpty() || dropAccount) && kinds.all { it == "calendar" || it == "sms" }) {
      "reset kinds must be calendar and/or sms, or dropAccount must be true"
    }
    return SeedRequest.Reset(namespace, kinds, dropAccount)
  }
  require(kind == "calendar" || kind == "sms") { "kind must be account, calendar, sms or reset" }
  val items = reader.read(requireNotNull(parameters["items"]) { "items JSON array is required" })
  return when (kind) {
    "calendar" -> SeedRequest.CalendarBatch(namespace, items.map { parseCalendar(it, namespace) })
    else -> SeedRequest.SmsBatch(namespace, items.map { parseSms(it) })
  }
}

private fun Map<String, Any?>.text(key: String): String {
  val value = this[key]
  require(value is String && value.isNotBlank() && !value.contains('\u0000')) {
    "$key must be nonblank text without NUL"
  }
  return value
}

private fun Map<String, Any?>.boolean(key: String): Boolean {
  if (!containsKey(key)) return false
  val value = this[key]
  require(value is Boolean) { "$key must be a boolean" }
  return value
}

private fun Map<String, Any?>.timestamp(key: String): Long {
  val value = this[key]
  require(
    value is Number && value.toDouble().isFinite() && value.toDouble() == value.toLong().toDouble(),
  ) {
    "$key must be integer Unix milliseconds"
  }
  return value.toLong()
}

private fun parseCalendar(item: Map<String, Any?>, namespace: String): SeedRequest.CalendarEvent {
  val start = item.timestamp("startMillis")
  val end = item.timestamp("endMillis")
  val allDay = item.boolean("allDay")
  require(end > start) { "end must be after start" }
  require(!allDay || (start % MILLIS_PER_DAY == 0L && end % MILLIS_PER_DAY == 0L)) {
    "allDay start and exclusive end must be UTC midnight"
  }
  return SeedRequest.CalendarEvent(
    item.text("title"),
    start,
    end,
    allDay,
    if (item.containsKey("location")) item.text("location") else null,
    if (item.containsKey("calendar")) item.text("calendar") else "automobile-$namespace",
  )
}

private fun parseSms(item: Map<String, Any?>): SeedRequest.SmsMessage =
  SeedRequest.SmsMessage(
    item.text("address"),
    item.text("body"),
    item.timestamp("dateMillis"),
    item.boolean("read"),
  )

private const val MILLIS_PER_DAY = 86_400_000L
