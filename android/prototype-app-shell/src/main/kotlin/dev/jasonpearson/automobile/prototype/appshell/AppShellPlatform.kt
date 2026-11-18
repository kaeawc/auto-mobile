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
 * What the packaged template's `capabilities.json` advertises to the host: the renderer's own
 * capabilities (core platform, clipboard, device and storage included) plus each registered
 * module's, without the SDK-gated renderer features a device at minSdk lacks. The host picks a
 * template from this list, so it must never promise more than any install of the shell provides.
 */
@OptIn(InternalAutoMobilePrototypeApi::class)
fun appShellTemplateCapabilities(platform: PrototypePlatform): Set<String> =
  (platform.capabilities - prototypeShaderCapabilities(Int.MAX_VALUE)).toSortedSet()
