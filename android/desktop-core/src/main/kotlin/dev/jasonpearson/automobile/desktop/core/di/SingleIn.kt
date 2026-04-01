package dev.jasonpearson.automobile.desktop.core.di

import dev.zacsweers.metro.Scope
import kotlin.annotation.AnnotationRetention.RUNTIME
import kotlin.reflect.KClass

/**
 * Custom scope annotation that provides type-safe scoping for dependencies.
 *
 * Unlike a generic singleton, this annotation requires you to specify which scope the dependency is
 * singleton within, making it explicit and preventing accidental scope leaks.
 *
 * Usage:
 * ```
 * @SingleIn(AppScope::class)
 * class MyRepository @Inject constructor(...)
 * ```
 *
 * @param scope The scope class that this dependency is singleton within
 */
@Scope @Retention(RUNTIME) annotation class SingleIn(val scope: KClass<*>)
