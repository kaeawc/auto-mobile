package dev.jasonpearson.automobile.playground.navigation

import android.util.Log

private const val TAG = "DeepLinkManager"

/** Generate deep link URL for onboarding screen */
fun DeepLinkManager.generateOnboardingUrl(): String {
  val url = buildUri(PATH_ONBOARDING)
  Log.d(TAG, "Generated onboarding URL: $url")
  return url
}

/** Generate deep link URL for login screen */
fun DeepLinkManager.generateLoginUrl(): String {
  val url = buildUri(PATH_LOGIN)
  Log.d(TAG, "Generated login URL: $url")
  return url
}

/** Generate deep link URL for home screen */
fun DeepLinkManager.generateHomeUrl(): String {
  val url = buildUri(PATH_HOME)
  Log.d(TAG, "Generated home URL: $url")
  return url
}

/** Generate deep link URL for slides screen */
fun DeepLinkManager.generateSlidesUrl(slideIndex: Int = 0): String {
  val url = buildUri("$PATH_SLIDES/$slideIndex")
  Log.d(TAG, "Generated slides URL with slideIndex $slideIndex: $url")
  return url
}

/** Generate deep link URL for video player screen */
fun DeepLinkManager.generateVideoPlayerUrl(videoId: String): String {
  val url = buildUri("$PATH_VIDEO_PLAYER/$videoId")
  Log.d(TAG, "Generated video player URL with videoId '$videoId': $url")
  return url
}

/** Generate deep link URL for settings screen */
fun DeepLinkManager.generateSettingsUrl(): String {
  val url = buildUri(PATH_SETTINGS)
  Log.d(TAG, "Generated settings URL: $url")
  return url
}
