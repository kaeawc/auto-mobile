package dev.jasonpearson.automobile.sdk

/** Shared constants used across the SDK. */
internal object SdkConstants {
  /** Package name of the CtrlProxy accessibility service companion app. */
  const val CTRL_PROXY_PACKAGE = "dev.jasonpearson.automobile.ctrlproxy"

  /** Signature-level permission for controlling SDK broadcast receivers. */
  const val PERMISSION_NETWORK_CONTROL =
    "dev.jasonpearson.automobile.sdk.permission.NETWORK_CONTROL"
}
