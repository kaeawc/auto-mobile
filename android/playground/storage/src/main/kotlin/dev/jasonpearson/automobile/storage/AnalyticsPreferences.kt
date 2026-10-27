package dev.jasonpearson.automobile.storage

import android.content.SharedPreferences
import android.util.Log
import androidx.core.content.edit
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

internal class AnalyticsPreferences(private val sharedPreferences: SharedPreferences) {
  private val breakdownJson = Json

  fun getTapBreakdown(): Map<String, Int> {
    val breakdownJson = sharedPreferences.getString(KEY_TAP_BREAKDOWN, "{}")
    return parseBreakdownJson(breakdownJson ?: "{}")
  }

  fun getSwipeBreakdown(): Map<String, Int> {
    val breakdownJson = sharedPreferences.getString(KEY_SWIPE_BREAKDOWN, "{}")
    return parseBreakdownJson(breakdownJson ?: "{}")
  }

  fun getScreenBreakdown(): Map<String, Int> {
    val breakdownJson = sharedPreferences.getString(KEY_SCREEN_BREAKDOWN, "{}")
    return parseBreakdownJson(breakdownJson ?: "{}")
  }

  private fun parseBreakdownJson(json: String): Map<String, Int> {
    return try {
      breakdownJson.decodeFromString<Map<String, Int>>(json)
    } catch (e: SerializationException) {
      Log.w("AnalyticsRepository", "Unable to decode analytics breakdown", e)
      emptyMap()
    }
  }

  fun saveBreakdown(key: String, breakdown: Map<String, Int>) {
    sharedPreferences.edit { putString(key, breakdownJson.encodeToString(breakdown)) }
  }

  fun getTodayStats(): DailyStats {
    val today = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())
    val todayTaps = sharedPreferences.getInt("${KEY_TODAY_TAPS}_$today", 0)
    val todaySwipes = sharedPreferences.getInt("${KEY_TODAY_SWIPES}_$today", 0)
    val todayScreens = sharedPreferences.getInt("${KEY_TODAY_SCREENS}_$today", 0)
    val todaySessions = sharedPreferences.getInt("${KEY_TODAY_SESSIONS}_$today", 0)
    val todayDuration = sharedPreferences.getLong("${KEY_TODAY_DURATION}_$today", 0)

    return DailyStats(
      date = today,
      taps = todayTaps,
      swipes = todaySwipes,
      screens = todayScreens,
      sessionCount = todaySessions,
      totalDuration = todayDuration,
    )
  }

  fun getWeeklyStats(): List<DailyStats> {
    val stats = mutableListOf<DailyStats>()
    val calendar = Calendar.getInstance()

    repeat(7) { i ->
      val date = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(calendar.time)
      val taps = sharedPreferences.getInt("${KEY_TODAY_TAPS}_$date", 0)
      val swipes = sharedPreferences.getInt("${KEY_TODAY_SWIPES}_$date", 0)
      val screens = sharedPreferences.getInt("${KEY_TODAY_SCREENS}_$date", 0)
      val sessions = sharedPreferences.getInt("${KEY_TODAY_SESSIONS}_$date", 0)
      val duration = sharedPreferences.getLong("${KEY_TODAY_DURATION}_$date", 0)

      stats.add(DailyStats(date, taps, swipes, screens, sessions, duration))
      calendar.add(Calendar.DAY_OF_YEAR, -1)
    }

    return stats.reversed()
  }

  fun updateDailyStats(taps: Int = 0, swipes: Int = 0, screens: Int = 0) {
    val today = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())

    sharedPreferences.edit {
      if (taps > 0) {
        val currentTaps = sharedPreferences.getInt("${KEY_TODAY_TAPS}_$today", 0)
        putInt("${KEY_TODAY_TAPS}_$today", currentTaps + taps)
      }
      if (swipes > 0) {
        val currentSwipes = sharedPreferences.getInt("${KEY_TODAY_SWIPES}_$today", 0)
        putInt("${KEY_TODAY_SWIPES}_$today", currentSwipes + swipes)
      }
      if (screens > 0) {
        val currentScreens = sharedPreferences.getInt("${KEY_TODAY_SCREENS}_$today", 0)
        putInt("${KEY_TODAY_SCREENS}_$today", currentScreens + screens)
      }
    }
  }

  fun loadUserStats(sessionStartTime: Long): UserStats {
    val taps = sharedPreferences.getInt(KEY_TAPS, 0)
    val swipes = sharedPreferences.getInt(KEY_SWIPES, 0)
    val screensNavigated = sharedPreferences.getInt(KEY_SCREENS_NAVIGATED, 0)
    val lastUpdated = sharedPreferences.getLong(KEY_LAST_UPDATED, System.currentTimeMillis())
    val totalSessions = sharedPreferences.getInt(KEY_TOTAL_SESSIONS, 1)
    val avgSessionDuration = sharedPreferences.getLong(KEY_AVG_SESSION_DURATION, 0)

    return UserStats(
      taps = taps,
      swipes = swipes,
      screensNavigated = screensNavigated,
      lastUpdated = lastUpdated,
      sessionStartTime = sessionStartTime,
      totalSessions = totalSessions,
      averageSessionDuration = avgSessionDuration,
      tapBreakdown = getTapBreakdown(),
      swipeBreakdown = getSwipeBreakdown(),
      screenBreakdown = getScreenBreakdown(),
      todayStats = getTodayStats(),
      weeklyStats = getWeeklyStats(),
    )
  }

  companion object {
    private const val KEY_TAPS = "taps"
    private const val KEY_SWIPES = "swipes"
    private const val KEY_SCREENS_NAVIGATED = "screens_navigated"
    private const val KEY_LAST_UPDATED = "last_updated"
    private const val KEY_TOTAL_SESSIONS = "total_sessions"
    private const val KEY_AVG_SESSION_DURATION = "avg_session_duration"
    private const val KEY_TAP_BREAKDOWN = "tap_breakdown"
    private const val KEY_SWIPE_BREAKDOWN = "swipe_breakdown"
    private const val KEY_SCREEN_BREAKDOWN = "screen_breakdown"
    private const val KEY_TODAY_TAPS = "today_taps"
    private const val KEY_TODAY_SWIPES = "today_swipes"
    private const val KEY_TODAY_SCREENS = "today_screens"
    private const val KEY_TODAY_SESSIONS = "today_sessions"
    private const val KEY_TODAY_DURATION = "today_duration"
  }
}
