package dev.jasonpearson.automobile.sdk

/**
 * Represents a navigation event in the application.
 *
 * @property destination The destination identifier (route, screen name, deep link, etc.)
 * @property timestamp When the navigation event occurred
 * @property source The navigation framework that generated this event
 * @property arguments Optional navigation arguments/parameters
 * @property metadata Additional metadata about the navigation event
 */
data class NavigationEvent(
    val destination: String,
    val timestamp: Long = System.currentTimeMillis(),
    val source: NavigationSource,
    val arguments: Map<String, Any?> = emptyMap(),
    val metadata: Map<String, String> = emptyMap(),
)

/** Identifies the source/framework of a navigation event. */
enum class NavigationSource(
    /** Platform-agnostic wire format value (lowercase snake_case, matches iOS rawValue). */
    val wireValue: String,
) {
  /** Jetpack Navigation Component (XML-based) */
  NAVIGATION_COMPONENT("navigation_component"),

  /** Jetpack Compose Navigation */
  COMPOSE_NAVIGATION("compose_navigation"),

  /** Circuit navigation library */
  CIRCUIT("circuit"),

  /** Custom or unknown navigation framework */
  CUSTOM("custom"),

  /** Deep link navigation */
  DEEP_LINK("deep_link"),

  /** Activity launch */
  ACTIVITY("activity");

  companion object {
    /** Look up a [NavigationSource] by its cross-platform wire value. */
    fun fromWireValue(value: String): NavigationSource? = entries.firstOrNull {
      it.wireValue == value
    }
  }
}
