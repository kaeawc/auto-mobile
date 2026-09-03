package dev.jasonpearson.automobile.sdk

import android.content.Context

/**
 * Configuration for navigation-only SDK initialization.
 *
 * This mode provides navigation event delivery without installing the broad SDK's inspection,
 * diagnostics, interaction, network, or performance integrations.
 */
class NavigationConfiguration(internal val context: Context)
