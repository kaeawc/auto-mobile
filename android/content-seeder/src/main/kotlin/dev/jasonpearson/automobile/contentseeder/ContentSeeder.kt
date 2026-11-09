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

internal class ContentSeeder(private val context: Context) {
  private val resolver: ContentResolver = context.contentResolver
  private val account = Account("AutoMobile content seeder", ACCOUNT_TYPE)

  fun seed(request: SeedRequest): Uri =
    when (request) {
      is SeedRequest.CalendarEvent -> seedCalendarEvent(request)
      is SeedRequest.SmsMessage -> seedSms(request)
    }

  private fun seedCalendarEvent(request: SeedRequest.CalendarEvent): Uri {
    val manager = AccountManager.get(context)
    check(
      manager.addAccountExplicitly(account, null, null) ||
        manager.getAccountsByType(ACCOUNT_TYPE).contains(account),
    ) {
      "Could not create the seeder account; check the authenticator registration"
    }
    val calendarId = findCalendar() ?: createCalendar()
    val values =
      ContentValues().apply {
        put(Events.CALENDAR_ID, calendarId)
        put(Events.TITLE, request.title)
        put(Events.DTSTART, request.startMillis)
        put(Events.DTEND, request.endMillis)
        put(Events.EVENT_TIMEZONE, "UTC")
      }
    return checkNotNull(resolver.insert(syncUri(Events.CONTENT_URI), values)) {
      "Calendar event insert returned no URI"
    }
  }

  private fun findCalendar(): Long? =
    resolver
      .query(
        syncUri(Calendars.CONTENT_URI),
        arrayOf(Calendars._ID),
        "${Calendars.ACCOUNT_NAME} = ? AND ${Calendars.ACCOUNT_TYPE} = ? AND ${Calendars.NAME} = ?",
        arrayOf(account.name, account.type, CALENDAR_NAME),
        null,
      )
      ?.use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else null }

  private fun createCalendar(): Long {
    val values =
      ContentValues().apply {
        put(Calendars.ACCOUNT_NAME, account.name)
        put(Calendars.ACCOUNT_TYPE, account.type)
        put(Calendars.NAME, CALENDAR_NAME)
        put(Calendars.CALENDAR_DISPLAY_NAME, "AutoMobile seed events")
        put(Calendars.CALENDAR_COLOR, Color.BLUE)
        put(Calendars.OWNER_ACCOUNT, account.name)
        put(Calendars.CALENDAR_ACCESS_LEVEL, Calendars.CAL_ACCESS_OWNER)
        put(Calendars.CALENDAR_TIME_ZONE, "UTC")
        put(Calendars.VISIBLE, 1)
        put(Calendars.SYNC_EVENTS, 1)
      }
    val uri =
      checkNotNull(resolver.insert(syncUri(Calendars.CONTENT_URI), values)) {
        "Calendar insert returned no URI"
      }
    return ContentUris.parseId(uri)
  }

  private fun syncUri(uri: Uri): Uri =
    uri
      .buildUpon()
      .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
      .appendQueryParameter(Calendars.ACCOUNT_NAME, account.name)
      .appendQueryParameter(Calendars.ACCOUNT_TYPE, account.type)
      .build()

  private fun seedSms(request: SeedRequest.SmsMessage): Uri {
    check(Telephony.Sms.getDefaultSmsPackage(context) == context.packageName) {
      "Grant the default SMS role with grant-content-seeder-roles.sh first"
    }
    val values =
      ContentValues().apply {
        put(Telephony.Sms.ADDRESS, request.address)
        put(Telephony.Sms.BODY, request.body)
        put(Telephony.Sms.DATE, request.dateMillis)
        put(Telephony.Sms.READ, 0)
      }
    return checkNotNull(resolver.insert(Telephony.Sms.Inbox.CONTENT_URI, values)) {
      "SMS insert returned no URI"
    }
  }

  companion object {
    const val ACCOUNT_TYPE = "dev.jasonpearson.automobile.contentseeder"
    private const val CALENDAR_NAME = "automobile-content-seeder"
  }
}
