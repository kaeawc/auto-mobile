package dev.jasonpearson.automobile.playground.navigation

import android.util.Log

private const val TAG = "DeepLinkManager"

/** Generate deep link URL for media/discover screen */
fun DeepLinkManager.generateMediaUrl(): String {
  val url = buildUri(PATH_MEDIA)
  Log.d(TAG, "Generated media URL: $url")
  return url
}

/** Generate deep link URL for tap screen (discover tab) */
fun DeepLinkManager.generateTapUrl(): String {
  val url = buildUri(PATH_TAP)
  Log.d(TAG, "Generated tap URL: $url")
  return url
}

/** Generate deep link URL for long press screen (discover tab alias) */
fun DeepLinkManager.generateLongPressUrl(): String {
  val url = buildUri(PATH_LONG_PRESS)
  Log.d(TAG, "Generated long press URL: $url")
  return url
}

/** Generate deep link URL for swipe screen (discover tab) */
fun DeepLinkManager.generateSwipeUrl(): String {
  val url = buildUri(PATH_SWIPE)
  Log.d(TAG, "Generated swipe URL: $url")
  return url
}

/** Generate deep link URL for text screen (discover tab) */
fun DeepLinkManager.generateTextUrl(): String {
  val url = buildUri(PATH_TEXT)
  Log.d(TAG, "Generated text URL: $url")
  return url
}

/** Generate deep link URL for chat screen (discover tab) */
fun DeepLinkManager.generateChatUrl(): String {
  val url = buildUri(PATH_CHAT)
  Log.d(TAG, "Generated chat URL: $url")
  return url
}

/** Generate deep link URL for video screen (discover tab) - alias for media */
fun DeepLinkManager.generateVideoUrl(): String {
  val url = buildUri(PATH_VIDEO)
  Log.d(TAG, "Generated video URL: $url")
  return url
}
