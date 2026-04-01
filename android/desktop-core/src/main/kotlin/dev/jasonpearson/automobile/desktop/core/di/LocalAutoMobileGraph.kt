package dev.jasonpearson.automobile.desktop.core.di

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * CompositionLocal providing the DI graph to the Compose UI tree.
 *
 * Usage:
 * ```
 * val client = LocalAutoMobileGraph.current.autoMobileClient
 * val factory = LocalAutoMobileGraph.current.dataSourceFactory
 * ```
 */
val LocalAutoMobileGraph = staticCompositionLocalOf<AutoMobileGraphProvider> {
    error("No AutoMobileGraph provided. Wrap your composable tree in CompositionLocalProvider(LocalAutoMobileGraph provides graph).")
}
