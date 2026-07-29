package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.workspace.Platform

/** The filter dimensions shown in the picker rail. */
enum class FilterDimension(val title: String) {
  State("State"),
  Platform("Platform"),
  OsVersion("OS version"),
  Architecture("Architecture"),
}

/** Active filter selections + the rail search query. Empty set for a dimension = no constraint. */
data class PickerFilters(
  val states: Set<DeviceState> = emptySet(),
  val platforms: Set<Platform> = emptySet(),
  val osKeys: Set<String> = emptySet(),
  val architectures: Set<String> = emptySet(),
  val query: String = "",
)

/** One selectable option in the rail, with its live count under the current sibling filters. */
data class FilterOption(
  val value: String,
  val label: String,
  val count: Int,
  val selected: Boolean,
)

internal fun Platform.label(): String = if (this == Platform.Ios) "iOS" else "Android"

internal fun DeviceState.label(): String = if (this == DeviceState.Booted) "Booted" else "Shutdown"

/** Match a device against every active dimension except [ignore] (for faceted counting). */
private fun matches(d: PickerDevice, f: PickerFilters, ignore: FilterDimension?): Boolean {
  if (ignore != FilterDimension.State && f.states.isNotEmpty() && d.state !in f.states) return false
  if (ignore != FilterDimension.Platform && f.platforms.isNotEmpty() && d.platform !in f.platforms)
    return false
  if (
    ignore != FilterDimension.OsVersion &&
      f.osKeys.isNotEmpty() &&
      (d.osKey == null || d.osKey !in f.osKeys)
  )
    return false
  if (
    ignore != FilterDimension.Architecture &&
      f.architectures.isNotEmpty() &&
      (d.architecture == null || d.architecture !in f.architectures)
  )
    return false
  return true
}

/** Devices matching the intersection of all active filters (the grid contents). */
fun filteredDevices(devices: List<PickerDevice>, f: PickerFilters): List<PickerDevice> =
  devices.filter {
    matches(it, f, ignore = null)
  }

private fun matchesQuery(label: String, query: String): Boolean =
  query.isBlank() || label.contains(query.trim(), ignoreCase = true)

/**
 * Options for one dimension, each with a live count computed under the OTHER active filters. The
 * OS-version dimension is gated: it returns no options until a platform filter is active. The rail
 * [PickerFilters.query] fuzzy-filters which option labels are shown.
 */
fun options(
  devices: List<PickerDevice>,
  f: PickerFilters,
  dimension: FilterDimension,
): List<FilterOption> {
  val visible = devices.filter { matches(it, f, ignore = dimension) }
  val raw: List<FilterOption> =
    when (dimension) {
      FilterDimension.State ->
        DeviceState.entries.map { state ->
          FilterOption(
            state.name,
            state.label(),
            visible.count { it.state == state },
            state in f.states,
          )
        }
      FilterDimension.Platform ->
        Platform.entries.map { platform ->
          FilterOption(
            platform.name,
            platform.label(),
            visible.count { it.platform == platform },
            platform in f.platforms,
          )
        }
      FilterDimension.OsVersion -> {
        if (f.platforms.isEmpty()) return emptyList()
        visible
          .filter { it.osKey != null }
          .groupBy { it.osKey!! }
          .toSortedMap(compareByDescending { it.toIntOrNull() ?: 0 })
          .map { (key, group) ->
            FilterOption(key, group.first().osLabel ?: key, group.size, key in f.osKeys)
          }
      }
      FilterDimension.Architecture ->
        visible
          .mapNotNull { it.architecture }
          .distinct()
          .sorted()
          .map { arch ->
            FilterOption(
              arch,
              arch,
              visible.count { it.architecture == arch },
              arch in f.architectures,
            )
          }
    }
  return raw.filter { it.count > 0 || it.selected }.filter { matchesQuery(it.label, f.query) }
}
