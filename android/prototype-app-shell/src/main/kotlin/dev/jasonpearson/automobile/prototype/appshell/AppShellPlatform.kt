package dev.jasonpearson.automobile.prototype.appshell

import androidx.activity.ComponentActivity
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidBiometricSource
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidLocationSource
import dev.jasonpearson.automobile.ctrlproxy.prototype.AndroidPermissionsSource
import dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeBiometricModule
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeLocationModule
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypePermissionsModule
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSecureStorageModule
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeShaderCapabilities
import dev.jasonpearson.automobile.prototype.PrototypePlatform

/**
 * The platform modules the disposable shell registers (#14184). The caller owns the result and
 * closes its modules once the renderer detaches. Biometric prompts and permission requests need the
 * hosting activity.
 */
fun appShellPlatform(activity: ComponentActivity): PrototypePlatform =
  PrototypePlatform(
    listOf(
      PrototypeLocationModule(AndroidLocationSource(activity)),
      PrototypeBiometricModule(AndroidBiometricSource(activity)),
      PrototypePermissionsModule(AndroidPermissionsSource(activity)),
      PrototypeSecureStorageModule.fileBacked(activity),
    ),
  )

/**
 * Renderer capabilities the shell does not wire: it passes the renderer no `PrototypeNetwork`
 * transport (it links no HTTP stack; see `verifyAppShellDependencies`), so a request would fail.
 */
val APP_SHELL_UNWIRED_CAPABILITIES: Set<String> =
  setOf("prototype_network_v1", "prototype_network_device_v1", "prototype_network_upload_v1")

/** The deep-link gate the shell advertises because its manifest filter and activity route links. */
const val APP_SHELL_LINKS_CAPABILITY: String = "prototype_links_v1"

/**
 * What the packaged template's `capabilities.json` advertises to the host: the renderer's own
 * capabilities (core platform, clipboard, device and storage included) plus each registered
 * module's, without the SDK-gated renderer features a device at minSdk lacks and without
 * [APP_SHELL_UNWIRED_CAPABILITIES], plus [APP_SHELL_LINKS_CAPABILITY]: the shell's manifest and
 * activity deliver `amp-` links, so it advertises the gate the renderer cannot know about. The host
 * picks a template from this list, so it must never promise more than any install of the shell
 * provides.
 */
@OptIn(InternalAutoMobilePrototypeApi::class)
fun appShellTemplateCapabilities(platform: PrototypePlatform): Set<String> =
  (platform.capabilities -
      prototypeShaderCapabilities(Int.MAX_VALUE) -
      APP_SHELL_UNWIRED_CAPABILITIES + APP_SHELL_LINKS_CAPABILITY)
    .toSortedSet()
