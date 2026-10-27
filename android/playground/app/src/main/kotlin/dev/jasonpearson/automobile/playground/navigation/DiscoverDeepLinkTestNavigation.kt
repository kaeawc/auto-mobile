package dev.jasonpearson.automobile.playground.navigation

import android.content.Context
import android.util.Log

private const val TAG = "DeepLinkManager"

// AutoMobile test integration methods

/** Navigate to media/discover screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToMediaForTest(context: Context) {
  Log.d(TAG, "Navigating to media for test")
  launchDeepLink(context, generateMediaUrl())
}

/** Navigate to tap screen (discover tab) via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToTapForTest(context: Context) {
  Log.d(TAG, "Navigating to tap for test")
  launchDeepLink(context, generateTapUrl())
}

/** Navigate to long press screen (discover tab alias) via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToLongPressForTest(context: Context) {
  Log.d(TAG, "Navigating to long press for test")
  launchDeepLink(context, generateLongPressUrl())
}

/** Navigate to swipe screen (discover tab) via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToSwipeForTest(context: Context) {
  Log.d(TAG, "Navigating to swipe for test")
  launchDeepLink(context, generateSwipeUrl())
}

/** Navigate to text screen (discover tab) via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToTextForTest(context: Context) {
  Log.d(TAG, "Navigating to text for test")
  launchDeepLink(context, generateTextUrl())
}

/** Navigate to chat screen (discover tab) via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToChatForTest(context: Context) {
  Log.d(TAG, "Navigating to chat for test")
  launchDeepLink(context, generateChatUrl())
}

/** Navigate to video screen (discover tab) via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToVideoForTest(context: Context) {
  Log.d(TAG, "Navigating to video for test")
  launchDeepLink(context, generateVideoUrl())
}
