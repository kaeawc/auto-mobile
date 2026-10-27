package dev.jasonpearson.automobile.playground.navigation

import android.util.Log

private const val TAG = "DeepLinkManager"

/** Generate deep link URL for demo index screen */
fun DeepLinkManager.generateDemosIndexUrl(): String {
  val url = buildUri(PATH_DEMOS)
  Log.d(TAG, "Generated demos index URL: $url")
  return url
}

/** Generate deep link URL for demo UX flow start screen */
fun DeepLinkManager.generateDemoUxStartUrl(): String {
  val url = buildUri(PATH_DEMO_UX_START)
  Log.d(TAG, "Generated demo UX start URL: $url")
  return url
}

/** Generate deep link URL for demo UX flow details screen */
fun DeepLinkManager.generateDemoUxDetailsUrl(): String {
  val url = buildUri(PATH_DEMO_UX_DETAILS)
  Log.d(TAG, "Generated demo UX details URL: $url")
  return url
}

/** Generate deep link URL for demo UX flow summary screen */
fun DeepLinkManager.generateDemoUxSummaryUrl(): String {
  val url = buildUri(PATH_DEMO_UX_SUMMARY)
  Log.d(TAG, "Generated demo UX summary URL: $url")
  return url
}

/** Generate deep link URL for demo startup screen */
fun DeepLinkManager.generateDemoStartupUrl(): String {
  val url = buildUri(PATH_DEMO_STARTUP)
  Log.d(TAG, "Generated demo startup URL: $url")
  return url
}

/** Generate deep link URL for demo performance list screen */
fun DeepLinkManager.generateDemoPerformanceListUrl(): String {
  val url = buildUri(PATH_DEMO_PERF_LIST)
  Log.d(TAG, "Generated demo performance list URL: $url")
  return url
}

/** Generate deep link URL for demo performance detail screen */
fun DeepLinkManager.generateDemoPerformanceDetailUrl(itemId: Int): String {
  val url = buildUri("$PATH_DEMO_PERF_DETAIL/$itemId")
  Log.d(TAG, "Generated demo performance detail URL for itemId $itemId: $url")
  return url
}

/** Generate deep link URL for demo contrast screen */
fun DeepLinkManager.generateDemoContrastUrl(): String {
  val url = buildUri(PATH_DEMO_A11Y_CONTRAST)
  Log.d(TAG, "Generated demo contrast URL: $url")
  return url
}

/** Generate deep link URL for demo tap targets screen */
fun DeepLinkManager.generateDemoTapTargetsUrl(): String {
  val url = buildUri(PATH_DEMO_A11Y_TAP_TARGETS)
  Log.d(TAG, "Generated demo tap targets URL: $url")
  return url
}

/** Generate deep link URL for demo bug reproduction screen */
fun DeepLinkManager.generateDemoBugReproUrl(): String {
  val url = buildUri(PATH_DEMO_BUG_REPRO)
  Log.d(TAG, "Generated demo bug repro URL: $url")
  return url
}

/** Generate deep link URL for demo pointer probe screen */
fun DeepLinkManager.generateDemoPointerProbeUrl(): String {
  val url = buildUri(PATH_DEMO_POINTER_PROBE)
  Log.d(TAG, "Generated demo pointer probe URL: $url")
  return url
}
