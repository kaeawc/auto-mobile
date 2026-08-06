package dev.jasonpearson.automobile.design.system.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import dev.jasonpearson.automobile.experimentation.Experiment
import dev.jasonpearson.automobile.experimentation.ExperimentRepository

// CompositionLocal for providing experiments to composables
val LocalExperiments = staticCompositionLocalOf<List<Experiment<*>>> { emptyList() }

/** Helper function to get a specific experiment by name from the current context */
@Composable
inline fun <reified T : Experiment<*>> getExperiment(experimentName: String): T? {
  val experiments = LocalExperiments.current
  return experiments.find { it.name == experimentName } as? T
}

// AutoMobile Light Color Scheme — icon-derived crayon palette (text pairs are
// WCAG-AA verified in PlaygroundContrastTest).
private val AutoMobileLightColorScheme =
  lightColorScheme(
    primary = PgLightPrimary,
    onPrimary = PgLightOnPrimary,
    primaryContainer = Color(0xFFFFDAD5),
    onPrimaryContainer = Color(0xFF410002),
    secondary = PgLightSecondary,
    onSecondary = PgLightOnSecondary,
    secondaryContainer = Color(0xFFD4E6FA),
    onSecondaryContainer = Color(0xFF0A2A45),
    tertiary = PgLightTertiary,
    onTertiary = PgLightOnTertiary,
    tertiaryContainer = Color(0xFFFFF0C2),
    onTertiaryContainer = Color(0xFF3A2E00),
    error = PgLightError,
    onError = PgLightOnError,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
    background = PgLightBackground,
    onBackground = PgLightOnBackground,
    surface = PgLightSurface,
    onSurface = PgLightOnSurface,
    surfaceVariant = Color(0xFFF3E8D8),
    onSurfaceVariant = PgLightOnSurface,
    outline = Color(0xFF8A7F70),
    outlineVariant = Color(0xFFD8CBB8),
    scrim = AutoMobileBlack,
    inverseSurface = Color(0xFF241E18),
    inverseOnSurface = PgLightBackground,
    inversePrimary = PgDarkPrimary,
    surfaceDim = Color(0xFFEFE4D4),
    surfaceBright = PgLightSurface,
    surfaceContainerLowest = AutoMobileWhite,
    surfaceContainerLow = Color(0xFFFDF3E6),
    surfaceContainer = Color(0xFFF9EDDD),
    surfaceContainerHigh = Color(0xFFF3E8D8),
    surfaceContainerHighest = Color(0xFFEDE1CF),
  )

// AutoMobile Dark Color Scheme — icon-derived crayon palette (text pairs are
// WCAG-AA verified in PlaygroundContrastTest).
private val AutoMobileDarkColorScheme =
  darkColorScheme(
    primary = PgDarkPrimary,
    onPrimary = PgDarkOnPrimary,
    primaryContainer = Color(0xFF7A2119),
    onPrimaryContainer = Color(0xFFFFDAD5),
    secondary = PgDarkSecondary,
    onSecondary = PgDarkOnSecondary,
    secondaryContainer = Color(0xFF1F4A72),
    onSecondaryContainer = Color(0xFFD4E6FA),
    tertiary = PgDarkTertiary,
    onTertiary = PgDarkOnTertiary,
    tertiaryContainer = Color(0xFF5A4A12),
    onTertiaryContainer = Color(0xFFFFF0C2),
    error = PgDarkError,
    onError = PgDarkOnError,
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
    background = PgDarkBackground,
    onBackground = PgDarkOnBackground,
    surface = PgDarkSurface,
    onSurface = PgDarkOnSurface,
    surfaceVariant = Color(0xFF3A2F24),
    onSurfaceVariant = PgDarkOnSurface,
    outline = Color(0xFF9C8E7C),
    outlineVariant = Color(0xFF3A2F24),
    scrim = AutoMobileBlack,
    inverseSurface = PgDarkOnSurface,
    inverseOnSurface = PgDarkSurface,
    inversePrimary = PgLightPrimary,
    surfaceDim = PgDarkBackground,
    surfaceBright = Color(0xFF3A322A),
    surfaceContainerLowest = Color(0xFF0E0B08),
    surfaceContainerLow = Color(0xFF1C1811),
    surfaceContainer = Color(0xFF211B14),
    surfaceContainerHigh = Color(0xFF2C251C),
    surfaceContainerHighest = Color(0xFF372F25),
  )

@Composable
fun AutoMobileTheme(
  darkTheme: Boolean = isSystemInDarkTheme(),
  dynamicColor: Boolean = false, // Disabled by default to use design system colors
  experimentRepository: ExperimentRepository? = null,
  content: @Composable () -> Unit,
) {
  val context = LocalContext.current
  val experiments = experimentRepository?.getExperiments() ?: emptyList()

  val colorScheme =
    when {
      dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
        if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
      }

      darkTheme -> AutoMobileDarkColorScheme
      else -> AutoMobileLightColorScheme
    }

  CompositionLocalProvider(LocalExperiments provides experiments) {
    MaterialTheme(
      colorScheme = colorScheme,
      typography = AutoMobileTypography,
      shapes = AutoMobileShapes,
      content = content,
    )
  }
}
