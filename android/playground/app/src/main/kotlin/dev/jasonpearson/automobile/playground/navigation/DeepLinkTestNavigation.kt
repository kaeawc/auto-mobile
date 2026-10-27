package dev.jasonpearson.automobile.playground.navigation

import android.content.Context
import android.util.Log

private const val TAG = "DeepLinkManager"

// AutoMobile test integration methods

/** Navigate to onboarding screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToOnboardingForTest(context: Context) {
  Log.d(TAG, "Navigating to onboarding for test")
  launchDeepLink(context, generateOnboardingUrl())
}

/** Navigate to login screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToLoginForTest(context: Context) {
  Log.d(TAG, "Navigating to login for test")
  launchDeepLink(context, generateLoginUrl())
}

/** Navigate to home screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToHomeForTest(context: Context) {
  Log.d(TAG, "Navigating to home for test")
  launchDeepLink(context, generateHomeUrl())
}

/** Navigate to slides screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToSlidesForTest(context: Context, slideIndex: Int = 0) {
  Log.d(TAG, "Navigating to slides for test with slideIndex: $slideIndex")
  launchDeepLink(context, generateSlidesUrl(slideIndex))
}

/** Navigate to video player screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToVideoPlayerForTest(context: Context, videoId: String) {
  Log.d(TAG, "Navigating to video player for test with videoId: '$videoId'")
  launchDeepLink(context, generateVideoPlayerUrl(videoId))
}

/** Navigate to settings screen via deep link for AutoMobile tests */
fun DeepLinkManager.navigateToSettingsForTest(context: Context) {
  Log.d(TAG, "Navigating to settings for test")
  launchDeepLink(context, generateSettingsUrl())
}
