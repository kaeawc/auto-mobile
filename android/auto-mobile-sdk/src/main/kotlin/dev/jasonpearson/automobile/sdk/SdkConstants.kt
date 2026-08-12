package dev.jasonpearson.automobile.sdk

/** Shared constants used across the SDK. */
internal object SdkConstants {
  /** Package name of the CtrlProxy accessibility service companion app. */
  const val CTRL_PROXY_PACKAGE = "dev.jasonpearson.automobile.ctrlproxy"

  /** Signature-level permission for controlling SDK broadcast receivers. */
  const val PERMISSION_NETWORK_CONTROL =
    "dev.jasonpearson.automobile.ctrlproxy.permission.NETWORK_CONTROL_V2"

  /** Permission held by released CtrlProxy versions before [PERMISSION_NETWORK_CONTROL]. */
  const val LEGACY_PERMISSION_NETWORK_CONTROL =
    "dev.jasonpearson.automobile.sdk.permission.NETWORK_CONTROL"

  /**
   * Permissions accepted from CtrlProxy control broadcasts, newest first.
   *
   * Dynamic receivers accept one sender permission per registration, so each permission requires a
   * distinct receiver registration.
   */
  val NETWORK_CONTROL_PERMISSIONS =
    listOf(PERMISSION_NETWORK_CONTROL, LEGACY_PERMISSION_NETWORK_CONTROL)
}
