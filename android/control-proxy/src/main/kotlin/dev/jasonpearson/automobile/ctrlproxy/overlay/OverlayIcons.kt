package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.material.icons.Icons
import androidx.compose.ui.graphics.vector.ImageVector
import java.util.Optional
import java.util.concurrent.ConcurrentHashMap

/**
 * Resolves a contract icon name (snake_case, e.g. `alarm_add`) to a bundled Material icon.
 *
 * The names are closed by the `iconName` definition in `schemas/overlay-spec-contract.json`, which
 * lists exactly the icons in `androidx.compose.material:material-icons-extended`. That library is
 * already part of the APK (the release build does not shrink), so the lookup adds no bytes. Each
 * icon is a top-level extension property compiled to a static getter on `<Pascal>Kt` in the package
 * for its style, so it is found by reflection instead of a 2,000-branch `when`. Keep
 * `proguard-rules.pro` keeping that package if shrinking is ever turned on. Unknown names keep the
 * neutral placeholder (`null`).
 */
fun overlayIcon(name: String?, variant: String? = null): ImageVector? {
  if (name == null || !ICON_NAME.matches(name)) return null
  val style = IconStyle.fromContract(variant)
  return ICON_CACHE.computeIfAbsent("${style.packageName}:$name") {
      Optional.ofNullable(load(style, name))
    }
    .orElse(null)
}

private val ICON_NAME = Regex("[a-z][a-z0-9]*(_[a-z0-9]+)*")
private val ICON_CACHE = ConcurrentHashMap<String, Optional<ImageVector>>()

private enum class IconStyle(
  val contractName: String,
  val packageName: String,
  val receiver: Any,
  val receiverType: Class<*>,
) {
  FILLED("filled", "filled", Icons.Filled, Icons.Filled::class.java),
  OUTLINED("outlined", "outlined", Icons.Outlined, Icons.Outlined::class.java),
  ROUNDED("rounded", "rounded", Icons.Rounded, Icons.Rounded::class.java),
  SHARP("sharp", "sharp", Icons.Sharp, Icons.Sharp::class.java),
  TWO_TONE("twoTone", "twotone", Icons.TwoTone, Icons.TwoTone::class.java);

  companion object {
    fun fromContract(name: String?): IconStyle =
      entries.firstOrNull { it.contractName == name } ?: FILLED
  }
}

private fun load(style: IconStyle, name: String): ImageVector? =
  loadStyle(style, name)
    ?: if (style != IconStyle.FILLED) loadStyle(IconStyle.FILLED, name) else null

private fun loadStyle(style: IconStyle, name: String): ImageVector? {
  val pascal = name.split('_').joinToString("") { it.replaceFirstChar(Char::uppercase) }
  return try {
    val owner = Class.forName("androidx.compose.material.icons.${style.packageName}.${pascal}Kt")
    owner.getMethod("get$pascal", style.receiverType).invoke(null, style.receiver) as? ImageVector
  } catch (_: ClassNotFoundException) {
    // Expected for names outside the bundled set; the caller renders the placeholder.
    null
  } catch (_: NoSuchMethodException) {
    // A class exists but exposes no such icon getter; treat it as an unknown name.
    null
  }
}
