package dev.jasonpearson.automobile.contentseeder

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import android.provider.Telephony
import org.json.JSONObject

internal class ContentSeeder(private val context: Context) {
  private val resolver: ContentResolver = context.contentResolver

  fun seed(request: SeedRequest): JSONObject {
    val account = Account("automobile.${request.namespace}", ACCOUNT_TYPE)
    val inserted: Int
    val removed: Int
    when (request) {
      is SeedRequest.Account -> return JSONObject().put("inserted", ensureAccount(account))
      is SeedRequest.CalendarBatch -> {
        ensureAccount(account)
        val ids = request.items.map { seedCalendarEvent(account, it) }
        inserted = verifyInserted(syncUri(Events.CONTENT_URI, account), ids)
        removed = 0
      }
      is SeedRequest.SmsBatch -> {
        val ids = request.items.map { seedSms(account.name, it) }
        inserted = verifyInserted(Telephony.Sms.Inbox.CONTENT_URI, ids)
        removed = 0
      }
      is SeedRequest.Reset -> {
        inserted = 0
        removed =
          (if ("calendar" in request.kinds) resetCalendar(account) else 0) +
            (if ("sms" in request.kinds) resetSms(account.name) else 0)
        if (request.dropAccount) dropAccount(account)
      }
    }
    return JSONObject().put("inserted", inserted).put("removed", removed)
  }

  private fun ensureAccount(account: Account): Int {
    val manager = AccountManager.get(context)
    if (manager.addAccountExplicitly(account, null, null)) return 1
    check(manager.getAccountsByType(ACCOUNT_TYPE).contains(account)) {
      "Could not create the seeder account; check the authenticator registration"
    }
    return 0
  }

  private fun seedCalendarEvent(account: Account, event: SeedRequest.CalendarEvent): Long {
    val calendarId =
      findCalendar(account, event.calendar) ?: createCalendar(account, event.calendar)
    val values =
      ContentValues().apply {
        put(Events.CALENDAR_ID, calendarId)
        put(Events.TITLE, event.title)
        put(Events.DTSTART, event.startMillis)
        put(Events.DTEND, event.endMillis)
        put(Events.ALL_DAY, if (event.allDay) 1 else 0)
        put(Events.EVENT_TIMEZONE, "UTC")
        put(Events.EVENT_LOCATION, event.location)
      }
    val uri =
      checkNotNull(resolver.insert(syncUri(Events.CONTENT_URI, account), values)) {
        "Calendar event insert returned no URI"
      }
    return ContentUris.parseId(uri)
  }

  private fun findCalendar(account: Account, name: String): Long? =
    checkNotNull(
        resolver.query(
          syncUri(Calendars.CONTENT_URI, account),
          arrayOf(Calendars._ID),
          "${Calendars.ACCOUNT_NAME} = ? AND ${Calendars.ACCOUNT_TYPE} = ? AND ${Calendars.NAME} = ?",
          arrayOf(account.name, account.type, name),
          null,
        ),
      ) {
        "Calendar query returned no cursor; check READ_CALENDAR"
      }
      .use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else null }

  private fun createCalendar(account: Account, name: String): Long {
    val values =
      ContentValues().apply {
        put(Calendars.ACCOUNT_NAME, account.name)
        put(Calendars.ACCOUNT_TYPE, account.type)
        put(Calendars.NAME, name)
        put(Calendars.CALENDAR_DISPLAY_NAME, name)
        put(Calendars.CALENDAR_COLOR, Color.BLUE)
        put(Calendars.OWNER_ACCOUNT, account.name)
        put(Calendars.CALENDAR_ACCESS_LEVEL, Calendars.CAL_ACCESS_OWNER)
        put(Calendars.CALENDAR_TIME_ZONE, "UTC")
        put(Calendars.VISIBLE, 1)
        put(Calendars.SYNC_EVENTS, 1)
      }
    val uri =
      checkNotNull(resolver.insert(syncUri(Calendars.CONTENT_URI, account), values)) {
        "Calendar insert returned no URI"
      }
    return ContentUris.parseId(uri)
  }

  private fun resetCalendar(account: Account): Int {
    val ids = mutableListOf<Long>()
    checkNotNull(
        resolver.query(
          syncUri(Calendars.CONTENT_URI, account),
          arrayOf(Calendars._ID),
          "${Calendars.ACCOUNT_NAME} = ? AND ${Calendars.ACCOUNT_TYPE} = ?",
          arrayOf(account.name, account.type),
          null,
        ),
      ) {
        "Calendar query returned no cursor; check READ_CALENDAR"
      }
      .use { cursor -> while (cursor.moveToNext()) ids.add(cursor.getLong(0)) }
    var removed = 0
    ids.forEach { id ->
      removed +=
        resolver.delete(
          syncUri(Events.CONTENT_URI, account),
          "${Events.CALENDAR_ID} = ?",
          arrayOf(id.toString()),
        )
    }
    resolver.delete(
      syncUri(Calendars.CONTENT_URI, account),
      "${Calendars.ACCOUNT_NAME} = ? AND ${Calendars.ACCOUNT_TYPE} = ?",
      arrayOf(account.name, account.type),
    )
    return removed
  }

  private fun dropAccount(account: Account) {
    val manager = AccountManager.get(context)
    if (manager.getAccountsByType(ACCOUNT_TYPE).contains(account)) {
      check(manager.removeAccountExplicitly(account)) {
        "Could not remove the namespace seeder account"
      }
    }
  }

  private fun verifyInserted(uri: Uri, ids: List<Long>): Int {
    if (ids.isEmpty()) return 0
    val count =
      checkNotNull(
          resolver.query(
            uri,
            arrayOf("_id"),
            "_id IN (${ids.joinToString(",") { "?" }})",
            ids.map { it.toString() }.toTypedArray(),
            null,
          ),
        ) {
          "Insert read-back returned no cursor; check provider read permissions"
        }
        .use { it.count }
    check(count == ids.size) {
      "Insert read-back expected ${ids.size} rows, found $count; check provider permissions and retry with reset"
    }
    return count
  }

  private fun syncUri(uri: Uri, account: Account): Uri =
    uri
      .buildUpon()
      .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
      .appendQueryParameter(Calendars.ACCOUNT_NAME, account.name)
      .appendQueryParameter(Calendars.ACCOUNT_TYPE, account.type)
      .build()

  private fun resetSms(tag: String): Int =
    resolver.delete(Telephony.Sms.CONTENT_URI, "${Telephony.Sms.SERVICE_CENTER} = ?", arrayOf(tag))

  private fun seedSms(tag: String, message: SeedRequest.SmsMessage): Long {
    // The provider enforces the role; framework default-package lookups can be stale.
    val values =
      ContentValues().apply {
        put(Telephony.Sms.ADDRESS, message.address)
        put(Telephony.Sms.BODY, message.body)
        put(Telephony.Sms.DATE, message.dateMillis)
        put(Telephony.Sms.READ, if (message.read) 1 else 0)
        put(Telephony.Sms.SERVICE_CENTER, tag)
      }
    val uri =
      checkNotNull(resolver.insert(Telephony.Sms.Inbox.CONTENT_URI, values)) {
        "SMS insert returned no URI; grant the default SMS role"
      }
    return ContentUris.parseId(uri)
  }

  companion object {
    const val ACCOUNT_TYPE = "dev.jasonpearson.automobile.contentseeder"
  }
}
