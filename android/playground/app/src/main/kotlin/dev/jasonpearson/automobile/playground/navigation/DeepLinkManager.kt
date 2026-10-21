package dev.jasonpearson.automobile.playground.navigation

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.net.toUri

/**
 * Utility class for managing deep link URLs within the AutoMobile Playground app. Provides methods
 * for generating and parsing deep link URLs for navigation.
 */
object DeepLinkManager {

  private const val TAG = "DeepLinkManager"

  /** Parse deep link URL and return the corresponding navigation destination */
  fun parseDeepLink(uri: Uri): AppDestination? {
    Log.d(TAG, "Parsing deep link URI: $uri")
    Log.d(
      TAG,
      "URI scheme: ${uri.scheme}, host: ${uri.host}, path: ${uri.path}, ssp: ${uri.schemeSpecificPart}",
    )

    if (uri.scheme != SCHEME) {
      Log.d(TAG, "Invalid scheme. Expected: $SCHEME")
      return null
    }

    val path = extractPath(uri) ?: return null

    if (path.isEmpty() && uri.schemeSpecificPart != HOST && uri.host != HOST) {
      Log.d(TAG, "Invalid URI format")
      return null
    }

    Log.d(TAG, "Extracted path: '$path'")

    val destination = exactDestinations[path]?.invoke(path) ?: parseParameterizedPath(path)

    Log.d(TAG, "Final parsed destination: $destination")
    return destination
  }

  private val exactDestinations: Map<String, (String) -> AppDestination> =
    mapOf(
      PATH_ONBOARDING to
        { _: String ->
          Log.d(TAG, "Parsed as OnboardingDestination")
          OnboardingDestination
        },
      PATH_LOGIN to
        { _: String ->
          Log.d(TAG, "Parsed as LoginDestination")
          LoginDestination
        },
      PATH_HOME to
        { path: String ->
          Log.d(TAG, "Parsed as HomeDestination with default tab (path: '$path')")
          HomeDestination(selectedTab = 0)
        },
      "" to
        { path: String ->
          Log.d(TAG, "Parsed as HomeDestination with default tab (path: '$path')")
          HomeDestination(selectedTab = 0)
        },
      PATH_MEDIA to
        { _: String ->
          Log.d(TAG, "Parsed as HomeDestination with media/discover tab selected")
          HomeDestination(selectedTab = 0, selectedSubTab = 2) // Media sub-tab is index 2
        },
      PATH_TAP to
        { _: String ->
          Log.d(TAG, "Parsed as HomeDestination with tap sub-tab selected")
          HomeDestination(selectedTab = 0, selectedSubTab = 0) // Tap sub-tab is index 0
        },
      PATH_LONG_PRESS to
        { _: String ->
          Log.d(TAG, "Parsed as HomeDestination with tap sub-tab selected (long press alias)")
          HomeDestination(selectedTab = 0, selectedSubTab = 0) // Tap sub-tab is index 0
        },
      PATH_SWIPE to
        { _: String ->
          Log.d(TAG, "Parsed as HomeDestination with swipe sub-tab selected")
          HomeDestination(selectedTab = 0, selectedSubTab = 1) // Swipe sub-tab is index 1
        },
      PATH_TEXT to
        { _: String ->
          Log.d(TAG, "Parsed as HomeDestination with text sub-tab selected")
          HomeDestination(selectedTab = 0, selectedSubTab = 3) // Text sub-tab is index 3
        },
      PATH_CHAT to
        { _: String ->
          Log.d(TAG, "Parsed as HomeDestination with chat sub-tab selected")
          HomeDestination(selectedTab = 0, selectedSubTab = 5) // Chat sub-tab is index 5
        },
      PATH_VIDEO to
        { _: String ->
          Log.d(TAG, "Parsed as HomeDestination with video sub-tab selected (alias for media)")
          HomeDestination(selectedTab = 0, selectedSubTab = 2) // Video is same as Media sub-tab
        },
      PATH_SETTINGS to
        { _: String ->
          Log.d(TAG, "Parsed as SettingsDestination")
          SettingsDestination
        },
      PATH_DEMOS to
        { _: String ->
          Log.d(TAG, "Parsed as DemoIndexDestination")
          DemoIndexDestination
        },
      PATH_DEMO_UX_START to
        { _: String ->
          Log.d(TAG, "Parsed as DemoUxStartDestination")
          DemoUxStartDestination
        },
      PATH_DEMO_UX_DETAILS to
        { _: String ->
          Log.d(TAG, "Parsed as DemoUxDetailsDestination")
          DemoUxDetailsDestination
        },
      PATH_DEMO_UX_SUMMARY to
        { _: String ->
          Log.d(TAG, "Parsed as DemoUxSummaryDestination")
          DemoUxSummaryDestination
        },
      PATH_DEMO_STARTUP to
        { _: String ->
          Log.d(TAG, "Parsed as DemoStartupDestination")
          DemoStartupDestination
        },
      PATH_DEMO_PERF_LIST to
        { _: String ->
          Log.d(TAG, "Parsed as DemoPerformanceListDestination")
          DemoPerformanceListDestination
        },
      PATH_DEMO_A11Y_CONTRAST to
        { _: String ->
          Log.d(TAG, "Parsed as DemoContrastDestination")
          DemoContrastDestination
        },
      PATH_DEMO_A11Y_TAP_TARGETS to
        { _: String ->
          Log.d(TAG, "Parsed as DemoTapTargetsDestination")
          DemoTapTargetsDestination
        },
      PATH_DEMO_BUG_REPRO to
        { _: String ->
          Log.d(TAG, "Parsed as DemoBugReproDestination")
          DemoBugReproDestination
        },
      PATH_DEMO_POINTER_PROBE to
        { _: String ->
          Log.d(TAG, "Parsed as DemoPointerProbeDestination")
          DemoPointerProbeDestination
        },
    )

  private fun parseParameterizedPath(path: String): AppDestination? =
    when {
      path.startsWith(PATH_SLIDES) -> {
        val slideIndex = path.substringAfterLast("/").toIntOrNull()?.takeIf { it >= 0 } ?: 0
        Log.d(TAG, "Parsed as SlidesDestination with slideIndex: $slideIndex")
        SlidesDestination(slideIndex)
      }
      path.startsWith(PATH_VIDEO_PLAYER) -> {
        val videoId = path.substringAfterLast("/")
        if (videoId.isNotEmpty()) {
          Log.d(TAG, "Parsed as VideoPlayerDestination with videoId: '$videoId'")
          VideoPlayerDestination(videoId)
        } else {
          Log.d(TAG, "Empty videoId for video player path")
          null
        }
      }
      path.startsWith(PATH_DEMO_PERF_DETAIL) -> {
        val itemId = path.substringAfterLast("/").toIntOrNull()
        if (itemId != null && itemId > 0) {
          Log.d(TAG, "Parsed as DemoPerformanceDetailDestination with itemId: $itemId")
          DemoPerformanceDetailDestination(itemId)
        } else {
          Log.d(TAG, "Invalid itemId for demo performance detail path")
          null
        }
      }
      else -> {
        Log.d(TAG, "No matching destination for path: $path")
        null
      }
    }

  private fun extractPath(uri: Uri): String? {
    return if (uri.host != null) {
      // Hierarchical URI: automobile://playground/path
      Log.d(TAG, "Parsing hierarchical URI format")
      if (uri.host != HOST) {
        Log.d(TAG, "Invalid host. Expected: $HOST, got: ${uri.host}")
        return null
      }
      // Extract path (already starts with "/")
      uri.path ?: ""
    } else {
      // Opaque URI: automobile:playground/path
      Log.d(TAG, "Parsing opaque URI format")
      val ssp = uri.schemeSpecificPart
      if (ssp == null || !ssp.startsWith(HOST)) {
        Log.d(TAG, "Invalid host. Expected scheme-specific part to start with: $HOST")
        return null
      }
      // Extract path from scheme-specific part (remove "playground" prefix)
      if (ssp.length > HOST.length) ssp.substring(HOST.length) else ""
    }
  }

  /** Validate if a URI is a valid deep link for this app */
  fun isValidDeepLink(uri: Uri): Boolean {
    Log.d(TAG, "Validating deep link: $uri")

    // Check scheme first
    if (uri.scheme != SCHEME) {
      Log.d(TAG, "Deep link validation result: false (invalid scheme)")
      return false
    }

    // Handle both hierarchical (automobile://playground/path) and opaque
    // (automobile:playground/path) URIs
    val hasValidHost =
      if (uri.host != null) {
        // Hierarchical URI: check host
        uri.host == HOST
      } else {
        // Opaque URI: check scheme-specific part
        uri.schemeSpecificPart?.startsWith(HOST) == true
      }

    if (!hasValidHost) {
      Log.d(TAG, "Deep link validation result: false (invalid host)")
      return false
    }

    // Try to parse the deep link
    val isValid = parseDeepLink(uri) != null
    Log.d(TAG, "Deep link validation result: $isValid")
    return isValid
  }

  private val destinationNames =
    mapOf(
      PATH_ONBOARDING to "Onboarding",
      PATH_LOGIN to "Login",
      PATH_HOME to "Home",
      "" to "Home",
      PATH_MEDIA to "Media",
      PATH_TAP to "Tap",
      PATH_LONG_PRESS to "Tap",
      PATH_SWIPE to "Swipe",
      PATH_TEXT to "Text",
      PATH_CHAT to "Chat",
      PATH_VIDEO to "Video",
      PATH_SETTINGS to "Settings",
      PATH_DEMOS to "Demo Index",
      PATH_DEMO_UX_START to "Demo UX Start",
      PATH_DEMO_UX_DETAILS to "Demo UX Details",
      PATH_DEMO_UX_SUMMARY to "Demo UX Summary",
      PATH_DEMO_STARTUP to "Demo Startup",
      PATH_DEMO_PERF_LIST to "Demo Performance List",
      PATH_DEMO_A11Y_CONTRAST to "Demo Contrast",
      PATH_DEMO_A11Y_TAP_TARGETS to "Demo Tap Targets",
      PATH_DEMO_BUG_REPRO to "Demo Bug Repro",
      PATH_DEMO_POINTER_PROBE to "Demo Pointer Probe",
    )

  private fun parameterizedDestinationName(path: String): String? =
    when {
      path.startsWith(PATH_SLIDES) -> "Slides"
      path.startsWith(PATH_VIDEO_PLAYER) -> "Video Player"
      path.startsWith(PATH_DEMO_PERF_DETAIL) -> "Demo Performance Detail"
      else -> null
    }

  /** Get the destination name from a deep link URI */
  fun getDestinationName(uri: Uri): String? {
    Log.d(TAG, "Getting destination name for URI: $uri")

    if (!isValidDeepLink(uri)) {
      Log.d(TAG, "Invalid deep link, returning null destination name")
      return null
    }

    // Extract path from scheme-specific part for opaque URIs
    val ssp = uri.schemeSpecificPart
    if (ssp == null || !ssp.startsWith(HOST)) {
      Log.d(TAG, "Invalid URI format, returning null destination name")
      return null
    }

    val path = if (ssp.length > HOST.length) ssp.substring(HOST.length) else ""

    val destinationName = destinationNames[path] ?: parameterizedDestinationName(path)

    Log.d(TAG, "Destination name: $destinationName")
    return destinationName
  }

  /** Generic method to launch a deep link intent for testing */
  fun launchDeepLink(context: Context, deepLinkUrl: String) {
    Log.d(TAG, "Launching deep link: $deepLinkUrl")
    Log.d(TAG, "Context package name: ${context.packageName}")

    val intent =
      Intent(Intent.ACTION_VIEW, deepLinkUrl.toUri()).apply {
        setPackage(context.packageName)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      }

    Log.d(TAG, "Intent created with flags: ${intent.flags}")
    Log.d(TAG, "Starting activity with intent")

    try {
      context.startActivity(intent)
      Log.d(TAG, "Successfully started activity for deep link")
    } catch (e: Exception) {
      Log.e(TAG, "Failed to start activity for deep link", e)
    }
  }

  /** Get all available deep link URLs for testing purposes */
  fun getAllDeepLinks(): List<Pair<String, String>> {
    Log.d(TAG, "Getting all available deep links")
    val deepLinks =
      listOf(
        "Onboarding" to generateOnboardingUrl(),
        "Login" to generateLoginUrl(),
        "Home" to generateHomeUrl(),
        "Media" to generateMediaUrl(),
        "Tap" to generateTapUrl(),
        "Long Press (alias)" to generateLongPressUrl(),
        "Swipe" to generateSwipeUrl(),
        "Text" to generateTextUrl(),
        "Chat" to generateChatUrl(),
        "Video" to generateVideoUrl(),
        "Slides (slide 0)" to generateSlidesUrl(0),
        "Slides (slide 3)" to generateSlidesUrl(3),
        "Video Player (sample)" to generateVideoPlayerUrl("sample123"),
        "Settings" to generateSettingsUrl(),
        "Demos Index" to generateDemosIndexUrl(),
        "Demo UX Start" to generateDemoUxStartUrl(),
        "Demo UX Details" to generateDemoUxDetailsUrl(),
        "Demo UX Summary" to generateDemoUxSummaryUrl(),
        "Demo Startup" to generateDemoStartupUrl(),
        "Demo Performance List" to generateDemoPerformanceListUrl(),
        "Demo Performance Detail (item 4)" to generateDemoPerformanceDetailUrl(4),
        "Demo Contrast" to generateDemoContrastUrl(),
        "Demo Tap Targets" to generateDemoTapTargetsUrl(),
        "Demo Bug Repro" to generateDemoBugReproUrl(),
        "Demo Pointer Probe" to generateDemoPointerProbeUrl(),
      )
    Log.d(TAG, "Generated ${deepLinks.size} deep links")
    return deepLinks
  }

  internal fun buildUri(path: String): String {
    // Build opaque URI in format "automobile:playground/path" instead of
    // "automobile://playground/path"
    val uri = "$SCHEME:$HOST$path"
    Log.d(TAG, "Built URI with path '$path': $uri")
    return uri
  }
}
