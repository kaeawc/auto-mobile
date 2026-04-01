package dev.jasonpearson.automobile.desktop.core.di

/**
 * Marker class representing the application scope in the Metro DI graph.
 *
 * Use this with:
 * - `@ContributesTo(AppScope::class)` to contribute modules to the app graph
 * - `@ContributesBinding(AppScope::class)` to contribute interface implementations
 * - `@SingleIn(AppScope::class)` to scope dependencies to the application lifetime
 */
abstract class AppScope private constructor()
