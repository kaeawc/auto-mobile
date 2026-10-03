package dev.jasonpearson.automobile.desktop.core.failures

internal enum class FailureSection {
  Captures,
  Screens,
  Devices,
  Versions,
  Tests,
  Occurrences,
  ErrorCodes,
  Parameters,
}

/** Immutable expansion state; Compose owns observation at the failure-detail boundary. */
internal data class ExpandableListState(
  private val expandedSections: Set<FailureSection> = emptySet()
) {
  fun isExpanded(section: FailureSection): Boolean = section in expandedSections

  fun toggle(section: FailureSection): ExpandableListState =
    copy(
      expandedSections =
        if (isExpanded(section)) expandedSections - section else expandedSections + section
    )

  fun <T> visible(section: FailureSection, items: List<T>, limit: Int = 5): List<T> =
    if (isExpanded(section)) items else items.take(limit)
}
