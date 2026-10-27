package dev.jasonpearson.automobile.storage

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json

data class UserStats(
  val taps: Int = 0,
  val swipes: Int = 0,
  val screensNavigated: Int = 0,
  val lastUpdated: Long = System.currentTimeMillis(),
  val sessionStartTime: Long = System.currentTimeMillis(),
  val totalSessions: Int = 1,
  val averageSessionDuration: Long = 0,
  val tapBreakdown: Map<String, Int> = emptyMap(),
  val swipeBreakdown: Map<String, Int> = emptyMap(),
  val screenBreakdown: Map<String, Int> = emptyMap(),
  val todayStats: DailyStats = DailyStats(),
  val weeklyStats: List<DailyStats> = emptyList(),
)

data class DailyStats(
  val date: String = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date()),
  val taps: Int = 0,
  val swipes: Int = 0,
  val screens: Int = 0,
  val sessionCount: Int = 0,
  val totalDuration: Long = 0,
)

data class AnalyticsEvent(
  val eventName: String,
  val timestamp: Long,
  val properties: Map<String, Any> = emptyMap(),
  val elementId: String? = null,
  val elementType: String? = null,
  val screenName: String? = null,
  val coordinates: Pair<Float, Float>? = null,
)

data class DetailedEventStats(
  val totalEvents: Int,
  val recentEvents: List<AnalyticsEvent>,
  val topElements: Map<String, Int>,
  val topScreens: Map<String, Int>,
  val hourlyDistribution: Map<Int, Int>,
)

class AnalyticsRepository
private constructor(context: Context, private val events: AnalyticsEventHistory) :
  AnalyticsReports by events {
  constructor(context: Context) : this(context, AnalyticsEventHistory())

  private val sharedPreferences: SharedPreferences =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  private val _currentScreen = MutableStateFlow<String?>(null)
  val currentScreen: StateFlow<String?> = _currentScreen.asStateFlow()

  private val _userStats = MutableStateFlow(UserStats())
  val userStats: StateFlow<UserStats> = _userStats.asStateFlow()

  private val breakdownJson = Json
  private val preferences = AnalyticsPreferences(sharedPreferences)

  private var sessionStartTime = System.currentTimeMillis()
  var isTrackingEnabled: Boolean
    get() = sharedPreferences.getBoolean(KEY_TRACKING_ENABLED, true)
    set(value) = sharedPreferences.edit { putBoolean(KEY_TRACKING_ENABLED, value) }

  init {
    // Initialize session
    sessionStartTime = System.currentTimeMillis()
    val sessionCount = sharedPreferences.getInt(KEY_TOTAL_SESSIONS, 0) + 1
    sharedPreferences.edit {
      putInt(KEY_TOTAL_SESSIONS, sessionCount)
      putLong(KEY_SESSION_START_TIME, sessionStartTime)
    }
    // Initialize the StateFlow with current stats
    _userStats.value = preferences.loadUserStats(sessionStartTime)
  }

  fun getUserStats(): UserStats {
    return _userStats.value
  }

  fun trackEvent(eventName: String, properties: Map<String, Any> = emptyMap()) {
    if (!isTrackingEnabled) return

    @Suppress("UNCHECKED_CAST") val coordinates = properties["coordinates"] as? Pair<Float, Float>

    when (eventName) {
      "tap",
      "button_click",
      "card_tap" ->
        incrementTaps(
          elementType = properties["elementType"] as? String,
          elementId = properties["elementId"] as? String,
          coordinates = coordinates,
        )

      "swipe",
      "scroll",
      "gesture" ->
        incrementSwipes(
          elementType = properties["elementType"] as? String,
          elementId = properties["elementId"] as? String,
          direction = properties["direction"] as? String,
          coordinates = coordinates,
        )

      "navigation",
      "screen_view" -> incrementScreensNavigated(screenName = properties["screenName"] as? String)
    }
  }

  fun incrementTaps(
    count: Int = 1,
    elementId: String? = null,
    elementType: String? = null,
    coordinates: Pair<Float, Float>? = null,
  ) {
    if (!isTrackingEnabled) return

    val currentStats = getUserStats()
    val newCount = currentStats.taps + count

    sharedPreferences.edit {
      putInt(KEY_TAPS, newCount)
      putLong(KEY_LAST_UPDATED, System.currentTimeMillis())
    }

    // Update breakdowns
    elementType?.let { type ->
      val breakdown = preferences.getTapBreakdown().toMutableMap()
      breakdown[type] = (breakdown[type] ?: 0) + count
      preferences.saveBreakdown(KEY_TAP_BREAKDOWN, breakdown)
    }

    // Update daily stats
    preferences.updateDailyStats(taps = count)

    // Track detailed event
    events.trackDetailedEvent(
      AnalyticsEvent(
        eventName = "tap",
        timestamp = System.currentTimeMillis(),
        elementId = elementId,
        elementType = elementType,
        coordinates = coordinates,
        screenName = _currentScreen.value,
      ),
    )

    // Performance monitoring
    events.monitorPerformance("tap")

    // Update the StateFlow with new stats
    _userStats.value = preferences.loadUserStats(sessionStartTime)
  }

  fun incrementSwipes(
    count: Int = 1,
    elementId: String? = null,
    elementType: String? = null,
    direction: String? = null,
    coordinates: Pair<Float, Float>? = null,
  ) {
    if (!isTrackingEnabled) return

    val currentStats = getUserStats()
    val newCount = currentStats.swipes + count

    sharedPreferences.edit {
      putInt(KEY_SWIPES, newCount)
      putLong(KEY_LAST_UPDATED, System.currentTimeMillis())
    }

    // Update breakdowns
    val breakdownKey =
      when {
        elementType != null && direction != null -> "$elementType-$direction"
        elementType != null -> elementType
        direction != null -> direction
        else -> "unknown"
      }

    val breakdown = preferences.getSwipeBreakdown().toMutableMap()
    breakdown[breakdownKey] = (breakdown[breakdownKey] ?: 0) + count
    preferences.saveBreakdown(KEY_SWIPE_BREAKDOWN, breakdown)

    // Update daily stats
    preferences.updateDailyStats(swipes = count)

    // Track detailed event
    events.trackDetailedEvent(
      AnalyticsEvent(
        eventName = "swipe",
        timestamp = System.currentTimeMillis(),
        elementId = elementId,
        elementType = elementType,
        coordinates = coordinates,
        properties = mapOf("direction" to (direction ?: "unknown")),
        screenName = _currentScreen.value,
      ),
    )

    // Performance monitoring
    events.monitorPerformance("swipe")

    // Update the StateFlow with new stats
    _userStats.value = preferences.loadUserStats(sessionStartTime)
  }

  fun incrementScreensNavigated(count: Int = 1, screenName: String? = null) {
    if (!isTrackingEnabled) return

    val currentStats = getUserStats()
    val newCount = currentStats.screensNavigated + count

    sharedPreferences.edit {
      putInt(KEY_SCREENS_NAVIGATED, newCount)
      putLong(KEY_LAST_UPDATED, System.currentTimeMillis())
    }

    // Update screen breakdown
    screenName?.let { screen ->
      val breakdown = preferences.getScreenBreakdown().toMutableMap()
      breakdown[screen] = (breakdown[screen] ?: 0) + count
      preferences.saveBreakdown(KEY_SCREEN_BREAKDOWN, breakdown)
    }

    // Update current screen
    _currentScreen.value = screenName

    // Update daily stats
    preferences.updateDailyStats(screens = count)

    // Track detailed event
    events.trackDetailedEvent(
      AnalyticsEvent(
        eventName = "screen_view",
        timestamp = System.currentTimeMillis(),
        elementId = screenName,
        screenName = _currentScreen.value,
      ),
    )

    // Performance monitoring
    events.monitorPerformance("screen_navigation")

    // Update the StateFlow with new stats
    _userStats.value = preferences.loadUserStats(sessionStartTime)
  }

  fun exportData(): Map<String, Any> {
    return mapOf(
      "userStats" to getUserStats(),
      "eventHistory" to events.eventHistory.takeLast(500), // Export last 500 events
      "performanceMetrics" to getPerformanceMetrics(),
      "exportTimestamp" to System.currentTimeMillis(),
    )
  }

  fun updateUserStats(stats: UserStats) {
    sharedPreferences.edit {
      putInt(KEY_TAPS, stats.taps)
      putInt(KEY_SWIPES, stats.swipes)
      putInt(KEY_SCREENS_NAVIGATED, stats.screensNavigated)
      putLong(KEY_LAST_UPDATED, stats.lastUpdated)
      putLong(KEY_AVG_SESSION_DURATION, stats.averageSessionDuration)
      putInt(KEY_TOTAL_SESSIONS, stats.totalSessions)
      putString(KEY_TAP_BREAKDOWN, breakdownJson.encodeToString(stats.tapBreakdown))
      putString(KEY_SWIPE_BREAKDOWN, breakdownJson.encodeToString(stats.swipeBreakdown))
      putString(KEY_SCREEN_BREAKDOWN, breakdownJson.encodeToString(stats.screenBreakdown))
    }
  }

  fun resetStats() {
    sharedPreferences.edit {
      putInt(KEY_TAPS, 0)
      putInt(KEY_SWIPES, 0)
      putInt(KEY_SCREENS_NAVIGATED, 0)
      putLong(KEY_LAST_UPDATED, System.currentTimeMillis())
      putString(KEY_TAP_BREAKDOWN, "{}")
      putString(KEY_SWIPE_BREAKDOWN, "{}")
      putString(KEY_SCREEN_BREAKDOWN, "{}")
    }
    events.clear()
    _userStats.value = UserStats()
  }

  fun clearAnalyticsData() {
    sharedPreferences.edit { clear() }
    events.clear()
    _userStats.value = UserStats()
  }

  fun endSession() {
    val sessionDuration = System.currentTimeMillis() - sessionStartTime
    val totalSessions = sharedPreferences.getInt(KEY_TOTAL_SESSIONS, 1)
    val currentAvgDuration = sharedPreferences.getLong(KEY_AVG_SESSION_DURATION, 0)
    val newAvgDuration =
      ((currentAvgDuration * (totalSessions - 1)) + sessionDuration) / totalSessions

    val today = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())

    sharedPreferences.edit {
      putLong(KEY_AVG_SESSION_DURATION, newAvgDuration)

      // Update today's session info
      val todaySessions = sharedPreferences.getInt("${KEY_TODAY_SESSIONS}_$today", 0)
      val todayDuration = sharedPreferences.getLong("${KEY_TODAY_DURATION}_$today", 0)
      putInt("${KEY_TODAY_SESSIONS}_$today", todaySessions + 1)
      putLong("${KEY_TODAY_DURATION}_$today", todayDuration + sessionDuration)
    }
  }

  companion object {
    private const val PREFS_NAME = "analytics_prefs"
    private const val KEY_TRACKING_ENABLED = "tracking_enabled"
    private const val KEY_TAPS = "taps"
    private const val KEY_SWIPES = "swipes"
    private const val KEY_SCREENS_NAVIGATED = "screens_navigated"
    private const val KEY_LAST_UPDATED = "last_updated"
    private const val KEY_TOTAL_SESSIONS = "total_sessions"
    private const val KEY_SESSION_START_TIME = "session_start_time"
    private const val KEY_AVG_SESSION_DURATION = "avg_session_duration"
    private const val KEY_TAP_BREAKDOWN = "tap_breakdown"
    private const val KEY_SWIPE_BREAKDOWN = "swipe_breakdown"
    private const val KEY_SCREEN_BREAKDOWN = "screen_breakdown"
    private const val KEY_TODAY_SESSIONS = "today_sessions"
    private const val KEY_TODAY_DURATION = "today_duration"
  }
}
