package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.layout.UIElementInfo

typealias ObservationData = dev.jasonpearson.automobile.desktop.domain.ObservationData

interface LayoutDataSource {
  suspend fun getViewHierarchy(): Result<UIElementInfo>

  /** Get the complete observation including hierarchy, screenshot, and screen dimensions. */
  suspend fun getObservation(): Result<ObservationData>
}
