package dev.jasonpearson.automobile.storage

import java.util.Calendar

interface AnalyticsReports {
  fun getDetailedEventStats(eventType: String): DetailedEventStats

  fun getPerformanceMetrics(): Map<String, Map<String, Double>>
}

internal class AnalyticsEventHistory : AnalyticsReports {
  val eventHistory = mutableListOf<AnalyticsEvent>()

  // Performance monitoring
  private var lastEventTime = 0L
  private val performanceMetrics = mutableMapOf<String, MutableList<Long>>()

  fun trackDetailedEvent(event: AnalyticsEvent) {
    // Keep only last 1000 events to prevent memory issues
    if (eventHistory.size >= 1000) {
      eventHistory.removeAt(0)
    }
    eventHistory.add(event)
  }

  fun monitorPerformance(eventType: String) {
    val currentTime = System.currentTimeMillis()
    if (lastEventTime > 0) {
      val timeDiff = currentTime - lastEventTime
      performanceMetrics.getOrPut(eventType) { mutableListOf() }.add(timeDiff)

      // Keep only last 100 measurements per event type
      performanceMetrics[eventType]?.let { list ->
        if (list.size > 100) {
          list.removeAt(0)
        }
      }
    }
    lastEventTime = currentTime
  }

  override fun getDetailedEventStats(eventType: String): DetailedEventStats {
    val filteredEvents = eventHistory.filter { it.eventName == eventType }
    val topElements =
      filteredEvents
        .mapNotNull { it.elementType }
        .groupingBy { it }
        .eachCount()
        .entries
        .sortedByDescending { it.value }
        .take(10)
        .associate { it.key to it.value }

    val topScreens =
      filteredEvents
        .mapNotNull { it.screenName }
        .groupingBy { it }
        .eachCount()
        .entries
        .sortedByDescending { it.value }
        .take(10)
        .associate { it.key to it.value }

    val hourlyDistribution =
      filteredEvents
        .groupBy {
          Calendar.getInstance().apply { timeInMillis = it.timestamp }.get(Calendar.HOUR_OF_DAY)
        }
        .mapValues { it.value.size }

    return DetailedEventStats(
      totalEvents = filteredEvents.size,
      recentEvents = filteredEvents.takeLast(50),
      topElements = topElements,
      topScreens = topScreens,
      hourlyDistribution = hourlyDistribution,
    )
  }

  override fun getPerformanceMetrics(): Map<String, Map<String, Double>> {
    return performanceMetrics.mapValues { (_, times) ->
      if (times.isEmpty()) {
        mapOf("avg" to 0.0, "min" to 0.0, "max" to 0.0)
      } else {
        mapOf(
          "avg" to times.average(),
          "min" to (times.minOrNull()?.toDouble() ?: 0.0),
          "max" to (times.maxOrNull()?.toDouble() ?: 0.0),
        )
      }
    }
  }

  fun clear() {
    eventHistory.clear()
    performanceMetrics.clear()
  }
}
