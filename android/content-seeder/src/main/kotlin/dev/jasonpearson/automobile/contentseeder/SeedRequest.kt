package dev.jasonpearson.automobile.contentseeder

sealed interface SeedRequest {
  data class CalendarEvent(val title: String, val startMillis: Long, val endMillis: Long) :
    SeedRequest

  data class SmsMessage(val address: String, val body: String, val dateMillis: Long) : SeedRequest
}

sealed interface SeedParseResult {
  data class Valid(val request: SeedRequest) : SeedParseResult

  data class Invalid(val message: String) : SeedParseResult
}

/**
 * String extras: kind=calendar (title/startMillis/endMillis) or sms (address/body/dateMillis).
 * Timestamps are nonnegative Unix milliseconds; calendar events use UTC.
 */
fun parseSeedRequest(parameters: Map<String, String?>): SeedParseResult =
  when (parameters["kind"]) {
    "calendar" -> parseCalendar(parameters)
    "sms" -> parseSms(parameters)
    else -> SeedParseResult.Invalid("kind must be calendar or sms")
  }

private fun parseCalendar(parameters: Map<String, String?>): SeedParseResult {
  val title =
    parameters["title"]?.takeIf { it.isNotBlank() }
      ?: return SeedParseResult.Invalid("title is required")
  val start =
    parameters["startMillis"].timestamp()
      ?: return SeedParseResult.Invalid("startMillis must be nonnegative Unix milliseconds")
  val end =
    parameters["endMillis"].timestamp()
      ?: return SeedParseResult.Invalid("endMillis must be nonnegative Unix milliseconds")
  if (end <= start) return SeedParseResult.Invalid("endMillis must be after startMillis")
  return SeedParseResult.Valid(SeedRequest.CalendarEvent(title, start, end))
}

private fun parseSms(parameters: Map<String, String?>): SeedParseResult {
  val address =
    parameters["address"]?.takeIf { it.isNotBlank() }
      ?: return SeedParseResult.Invalid("address is required")
  val body =
    parameters["body"]?.takeIf { it.isNotBlank() }
      ?: return SeedParseResult.Invalid("body is required")
  val date =
    parameters["dateMillis"].timestamp()
      ?: return SeedParseResult.Invalid("dateMillis must be nonnegative Unix milliseconds")
  return SeedParseResult.Valid(SeedRequest.SmsMessage(address, body, date))
}

private fun String?.timestamp(): Long? = this?.toLongOrNull()?.takeIf { it >= 0 }
