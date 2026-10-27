package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import kotlinx.coroutines.delay

@Composable
internal fun ObserveTelemetry1(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(activeDeviceId) {
        // Save current events + counts to cache before switching
        if (previousDeviceId != null && events.isNotEmpty()) {
          deviceEventCache[
            requireNotNull(previousDeviceId) {
              "Previous device is required for the device-change divider"
            }] = events.toList()
          deviceCountCache[
            requireNotNull(previousDeviceId) {
              "Previous device is required for the device-change divider"
            }] = categoryCounts.toMap()
        }
        // Restore cached events + counts for the new device, or clear
        events.clear()
        categoryCounts.clear()
        lastSeenCounts.clear()
        val cached = activeDeviceId?.let { deviceEventCache[it] }
        if (cached != null) {
          events.addAll(cached)
        }
        val cachedCounts = activeDeviceId?.let { deviceCountCache[it] }
        if (cachedCounts != null) {
          categoryCounts.putAll(cachedCounts)
        }
        previousDeviceId = activeDeviceId
      }
    }
  }
}

@Composable
internal fun ObserveTelemetry2(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(searchQuery) {
        delay(150)
        debouncedQuery = searchQuery
      }
    }
  }
}

@Composable
internal fun ObserveTelemetry3(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(activeDeviceId) {
        cachedMaxTimestamp.value = events.maxOfOrNull { it.timestamp } ?: 0L
      }
    }
  }
}

@Composable
internal fun ObserveTelemetry4(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(telemetryPushClient, isPaused) {
        val client = telemetryPushClient ?: return@LaunchedEffect
        client.telemetryEvents.collect { event ->
          if (!isPaused) {
            // Skip events we already have from cache restore
            if (
              event.timestamp <= cachedMaxTimestamp.value &&
                events.any { it.timestamp == event.timestamp && it::class == event::class }
            ) {
              return@collect
            }
            events.add(event)
            incrementCount(categoryCounts, event)
            trimEvents(events, maxEvents, categoryCounts)
          }
        }
      }
    }
  }
}

@Composable
internal fun ObserveTelemetry5(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(Unit) {
        snapshotFlow {
          val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
          val totalItems = listState.layoutInfo.totalItemsCount
          totalItems - lastVisible <= 3
        }
          .collect { nearBottom ->
            autoScrollEnabled = nearBottom
          }
      }
    }
  }
}

@Composable
internal fun ObserveTelemetry6(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(telemetryPushClient) {
        val client = telemetryPushClient ?: return@LaunchedEffect
        client.connectionState.collect { state -> connectionState = state }
      }
    }
  }
}

@Composable
internal fun ObserveTelemetry7(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(dataSourceMode) {
        if (dataSourceMode != DataSourceMode.Fake) return@LaunchedEffect
        val fakeEvents = generateFakeEvents()
        events.addAll(fakeEvents)
        // Initialize incremental counts from bulk-added fake events
        categoryCounts[CategoryFilter.All] =
          (categoryCounts[CategoryFilter.All] ?: 0) + fakeEvents.size
        for (e in fakeEvents) {
          val cat = categoryOf(e) ?: continue
          categoryCounts[cat] = (categoryCounts[cat] ?: 0) + 1
        }
      }
    }
  }
}
