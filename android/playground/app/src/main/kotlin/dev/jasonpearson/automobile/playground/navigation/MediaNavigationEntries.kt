package dev.jasonpearson.automobile.playground.navigation

import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.jasonpearson.automobile.mediaplayer.VideoPlayerScreen
import dev.jasonpearson.automobile.sdk.adapters.Navigation3Adapter
import dev.jasonpearson.automobile.slides.SlidesScreen
import dev.jasonpearson.automobile.storage.NavigationTracker

private const val TAG = "AppNavigation"

internal fun EntryProviderScope<NavKey>.mediaNavigationEntries(state: NavigationState) {
  entry<SlidesDestination> { slidesDestination -> SlidesEntry(slidesDestination, state) }
  entry<VideoPlayerDestination> { videoPlayerDestination ->
    VideoPlayerEntry(videoPlayerDestination, state)
  }
}

@Composable
private fun SlidesEntry(slidesDestination: SlidesDestination, state: NavigationState) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(
    destination = slidesDestination,
    extractArguments = { mapOf("slideIndex" to it.slideIndex) },
  )
  LaunchedEffect(Unit) {
    Log.d(
      TAG,
      "Navigated to SlidesScreen with slideIndex: ${slidesDestination.slideIndex}",
    )
    analyticsTracker.trackScreenView("SlidesScreen")
  }
  Box(
    modifier =
      Modifier.destinationSemanticModifier<SlidesDestination>(
        "slide_${slidesDestination.slideIndex}",
      ),
  ) {
    SlidesScreen(
      initialSlideIndex = slidesDestination.slideIndex,
      onNavigateBack = {
        val destination = backStack.popOrGoHome(HomeDestination())
        val screenName = destination::class.simpleName?.removeSuffix("Destination") + "Screen"
        Log.d(TAG, "Navigating back from SlidesScreen to $screenName")
        NavigationTracker.trackNavigation(
          "SlidesScreen",
          screenName,
          "back_navigation",
        )
      },
    )
  }
}

@Composable
private fun VideoPlayerEntry(
  videoPlayerDestination: VideoPlayerDestination,
  state: NavigationState,
) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(
    destination = videoPlayerDestination,
    extractArguments = { mapOf("videoId" to it.videoId) },
  )
  LaunchedEffect(Unit) {
    Log.d(
      TAG,
      "Navigated to VideoPlayerScreen with videoId: ${videoPlayerDestination.videoId}",
    )
    analyticsTracker.trackScreenView("VideoPlayerScreen")
  }
  Box(
    modifier =
      Modifier.destinationSemanticModifier<VideoPlayerDestination>(
        "video_${videoPlayerDestination.videoId}",
      ),
  ) {
    VideoPlayerScreen(
      videoId = videoPlayerDestination.videoId,
      onNavigateBack = {
        val destination = backStack.popOrGoHome(HomeDestination())
        val screenName = destination::class.simpleName?.removeSuffix("Destination") + "Screen"
        Log.d(TAG, "Navigating back from VideoPlayerScreen to $screenName")
        NavigationTracker.trackNavigation(
          "VideoPlayerScreen",
          screenName,
          "back_navigation",
        )
      },
    )
  }
}
