package dev.jasonpearson.automobile.playground.navigation

import android.content.Context
import android.util.Log

private const val TAG = "DeepLinkManager"

/** Navigate to demos index screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToDemosIndexForTest(context: Context) {
  Log.d(TAG, "Navigating to demos index for test")
  launchDeepLink(context, generateDemosIndexUrl())
}

/** Navigate to demo UX flow start via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToDemoUxStartForTest(context: Context) {
  Log.d(TAG, "Navigating to demo UX start for test")
  launchDeepLink(context, generateDemoUxStartUrl())
}

/** Navigate to demo UX flow details via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToDemoUxDetailsForTest(context: Context) {
  Log.d(TAG, "Navigating to demo UX details for test")
  launchDeepLink(context, generateDemoUxDetailsUrl())
}

/** Navigate to demo UX flow summary via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToDemoUxSummaryForTest(context: Context) {
  Log.d(TAG, "Navigating to demo UX summary for test")
  launchDeepLink(context, generateDemoUxSummaryUrl())
}

/** Navigate to demo startup screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToDemoStartupForTest(context: Context) {
  Log.d(TAG, "Navigating to demo startup for test")
  launchDeepLink(context, generateDemoStartupUrl())
}

/** Navigate to demo performance list screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToDemoPerformanceListForTest(context: Context) {
  Log.d(TAG, "Navigating to demo performance list for test")
  launchDeepLink(context, generateDemoPerformanceListUrl())
}

/** Navigate to demo performance detail screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToDemoPerformanceDetailForTest(context: Context, itemId: Int) {
  Log.d(TAG, "Navigating to demo performance detail for test with itemId: $itemId")
  launchDeepLink(context, generateDemoPerformanceDetailUrl(itemId))
}

/** Navigate to demo contrast screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToDemoContrastForTest(context: Context) {
  Log.d(TAG, "Navigating to demo contrast for test")
  launchDeepLink(context, generateDemoContrastUrl())
}

/** Navigate to demo tap targets screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToDemoTapTargetsForTest(context: Context) {
  Log.d(TAG, "Navigating to demo tap targets for test")
  launchDeepLink(context, generateDemoTapTargetsUrl())
}

/** Navigate to demo bug reproduction screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToDemoBugReproForTest(context: Context) {
  Log.d(TAG, "Navigating to demo bug repro for test")
  launchDeepLink(context, generateDemoBugReproUrl())
}
