package dev.jasonpearson.automobile.slides

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import dev.jasonpearson.automobile.design.system.components.AutoMobileIconButton
import dev.jasonpearson.automobile.design.system.theme.AutoMobileTheme
import dev.jasonpearson.automobile.sdk.TrackRecomposition
import dev.jasonpearson.automobile.slides.components.BulletPointSlideItem
import dev.jasonpearson.automobile.slides.components.CodeSampleSlideItem
import dev.jasonpearson.automobile.slides.components.EmojiSlideItem
import dev.jasonpearson.automobile.slides.components.LargeTextSlideItem
import dev.jasonpearson.automobile.slides.components.MermaidDiagramSlideItem
import dev.jasonpearson.automobile.slides.components.ScreenshotSlideItem
import dev.jasonpearson.automobile.slides.components.VideoPlayerSlideItem
import dev.jasonpearson.automobile.slides.components.VisualizationSlideItem
import dev.jasonpearson.automobile.slides.data.getAllSlides
import dev.jasonpearson.automobile.slides.model.SlideContent
import kotlinx.coroutines.launch

/**
 * Main slides screen with horizontal paging for conference presentations. Supports deep linking to
 * specific slide indices and navigation controls. Uses AutoMobile design system theme for
 * consistent colors across day/night modes.
 */
@Composable
fun SlidesScreen(
  modifier: Modifier = Modifier,
  slides: List<SlideContent> = getAllSlides(),
  initialSlideIndex: Int = 0,
  onNavigateBack: (() -> Unit)? = null,
) {
  TrackRecomposition(id = "screen.slides", composableName = "SlidesScreen") {
    val context = LocalContext.current
    val themeManager = remember(context) { SlidesThemeManager(context) }

    SlidesImmersiveMode(context)

    // Remember PagerState with saveable current page
    val savedPage: MutableState<Int> = rememberSaveable { mutableIntStateOf(initialSlideIndex) }

    val pagerState =
      rememberPagerState(
        initialPage = savedPage.value.coerceIn(0, slides.size - 1),
        pageCount = { slides.size },
      )

    // Update saved page when current page changes
    LaunchedEffect(pagerState.currentPage) { savedPage.value = pagerState.currentPage }

    // Restore to saved position if needed (e.g., after configuration change)
    LaunchedEffect(Unit) {
      if (pagerState.currentPage != savedPage.value && savedPage.value in 0 until slides.size) {
        pagerState.scrollToPage(savedPage.value)
      }
    }

    SlidesPager(slides, pagerState, themeManager, modifier)
  }
}

/** Individual slide item that renders different slide content types. */
@androidx.media3.common.util.UnstableApi
@Composable
private fun SlideItem(
  slideContent: SlideContent,
  isDarkMode: Boolean,
  modifier: Modifier = Modifier,
) {
  when (slideContent) {
    is SlideContent.LargeText ->
      LargeTextSlideItem(
        title = slideContent.title,
        subtitle = slideContent.subtitle,
        modifier = modifier,
      )

    is SlideContent.BulletPoints ->
      BulletPointSlideItem(
        content = slideContent,
        modifier = modifier,
      )

    is SlideContent.Emoji ->
      EmojiSlideItem(
        emoji = slideContent.emoji,
        caption = slideContent.caption,
        modifier = modifier,
      )

    is SlideContent.CodeSample ->
      CodeSampleSlideItem(
        content = slideContent,
        isDarkMode = isDarkMode,
        modifier = modifier,
      )

    is SlideContent.Visualization ->
      VisualizationSlideItem(
        imageUrl = slideContent.imageUrl,
        caption = slideContent.caption,
        contentDescription = slideContent.contentDescription,
        modifier = modifier,
      )

    is SlideContent.Video ->
      VideoPlayerSlideItem(
        content = slideContent,
        modifier = modifier,
      )

    is SlideContent.MermaidDiagram ->
      MermaidDiagramSlideItem(
        mermaidCode = slideContent.code,
        title = slideContent.title,
        isDarkMode = isDarkMode,
        modifier = modifier,
      )

    is SlideContent.Screenshot ->
      ScreenshotSlideItem(
        content = slideContent,
        modifier = modifier,
      )
  }
}

@androidx.media3.common.util.UnstableApi
@Preview(showBackground = true)
@Composable
fun SlidesScreenPreview() {
  AutoMobileTheme {
    SlidesScreen(slides = listOf(SlideContent.LargeText("Slide Title")), initialSlideIndex = 0)
  }
}

@Composable
private fun SlidesImmersiveMode(context: android.content.Context) {
  // Enable immersive mode
  DisposableEffect(Unit) {
    val activity = context as? androidx.activity.ComponentActivity
    activity?.let {
      val window = it.window
      val insetsController = WindowCompat.getInsetsController(window, window.decorView)

      // Hide system bars
      insetsController.hide(WindowInsetsCompat.Type.systemBars())
      insetsController.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

      // Make content appear behind system bars
      WindowCompat.setDecorFitsSystemWindows(window, false)
    }

    onDispose {
      // Restore normal mode when leaving
      activity?.let {
        val window = it.window
        val insetsController = WindowCompat.getInsetsController(window, window.decorView)
        insetsController.show(WindowInsetsCompat.Type.systemBars())
        WindowCompat.setDecorFitsSystemWindows(window, true)
      }
    }
  }
}

@Composable
private fun SlideNavigationArea(description: String, modifier: Modifier, onClick: () -> Unit) {
  Box(
    modifier =
      modifier
        .semantics { contentDescription = description }
        .clickable(
          interactionSource = remember { MutableInteractionSource() },
          indication = null,
          onClick = onClick,
        ),
  )
}

@Composable
private fun SlideThemeToggle(isDarkMode: Boolean, onToggle: () -> Unit, modifier: Modifier) {
  // Day/Night mode toggle - floating in bottom right corner
  AutoMobileIconButton(
    onClick = onToggle,
    modifier = modifier.size(64.dp).windowInsetsPadding(WindowInsets.systemBars).padding(16.dp),
  ) {
    Icon(
      imageVector = if (!isDarkMode) Icons.Filled.LightMode else Icons.Filled.DarkMode,
      contentDescription = if (!isDarkMode) "Light Mode" else "Dark Mode",
      modifier = Modifier.size(32.dp),
      tint = MaterialTheme.colorScheme.onSurface,
    )
  }
}

@Composable
private fun SlidesPager(
  slides: List<SlideContent>,
  pagerState: androidx.compose.foundation.pager.PagerState,
  themeManager: SlidesThemeManager,
  modifier: Modifier,
) {
  val isDarkMode = themeManager.isDarkMode
  AutoMobileTheme(darkTheme = isDarkMode) {
    Column(modifier = modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
      // Slide content with floating day/night button and tap navigation
      Box(modifier = Modifier.weight(1f)) {
        HorizontalPager(
          state = pagerState,
          userScrollEnabled = false,
          modifier = Modifier.fillMaxSize(),
        ) { page ->
          SlideItem(
            slideContent = slides[page],
            isDarkMode = isDarkMode,
            modifier =
              Modifier.fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .windowInsetsPadding(WindowInsets.displayCutout),
          )
        }

        SlideNavigation(pagerState, slides.size)

        SlideThemeToggle(
          isDarkMode,
          { themeManager.toggleTheme() },
          Modifier.align(Alignment.BottomEnd),
        )
      }

      // Progress bar - pinned to bottom with minimal height and no padding
      LinearProgressIndicator(
        progress = (pagerState.currentPage + 1f) / slides.size,
        modifier =
          Modifier.fillMaxWidth()
            .size(height = 2.dp, width = 0.dp)
            .windowInsetsPadding(WindowInsets.navigationBars),
      )
    }
  }
}

@Composable
private fun androidx.compose.foundation.layout.BoxScope.SlideNavigation(
  pagerState: androidx.compose.foundation.pager.PagerState,
  slideCount: Int,
) {
  val configuration = LocalConfiguration.current
  val coroutineScope = rememberCoroutineScope()
  SlideNavigationArea(
    description = "Previous",
    modifier =
      Modifier.width((configuration.screenWidthDp * 0.3f).dp)
        .fillMaxHeight()
        .align(Alignment.CenterStart),
  ) {
    if (pagerState.currentPage > 0) {
      coroutineScope.launch { pagerState.scrollToPage(pagerState.currentPage - 1) }
    }
  }
  SlideNavigationArea(
    description = "Next",
    modifier =
      Modifier.width((configuration.screenWidthDp * 0.3f).dp)
        .fillMaxHeight()
        .align(Alignment.CenterEnd),
  ) {
    if (pagerState.currentPage < slideCount - 1) {
      coroutineScope.launch { pagerState.scrollToPage(pagerState.currentPage + 1) }
    }
  }
}
