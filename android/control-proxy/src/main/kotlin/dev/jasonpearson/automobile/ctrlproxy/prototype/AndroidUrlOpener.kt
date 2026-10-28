package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.core.net.toUri

// Android `links.open` (#14238). The plan is pure and tested with a fake gateway; the system
// gateway is the only code that touches PackageManager or starts an activity.

/** The intent action a scheme opens with. Nothing here ever places a call or sends a message. */
internal enum class LinkAction(val intentAction: String) {
  VIEW(Intent.ACTION_VIEW),
  /** `tel:` fills in the dialer; `ACTION_CALL` would need CALL_PHONE and place the call. */
  DIAL(Intent.ACTION_DIAL),
  /** `mailto:` and `sms:` open a composer; the user still has to send. */
  SENDTO(Intent.ACTION_SENDTO),
}

/** How one URL is opened: [customTab] adds the Custom Tabs session extra to a VIEW intent. */
internal data class LinkPlan(
  val action: LinkAction,
  val customTab: Boolean,
  val mode: LinkMode,
  val fallback: Boolean,
)

/**
 * Only http(s) can open in a Custom Tab; every other allowlisted scheme opens externally. `inApp`
 * without a Custom Tabs provider (AOSP images without Chrome) opens externally and reports a
 * fallback; `auto` makes the same choice silently.
 */
internal fun linkPlan(url: String, mode: LinkMode, customTabsAvailable: Boolean): LinkPlan {
  val scheme = url.substringBefore(':')
  val action =
    when (scheme) {
      "tel" -> LinkAction.DIAL
      "mailto",
      "sms" -> LinkAction.SENDTO
      else -> LinkAction.VIEW
    }
  val web = scheme == "http" || scheme == "https"
  if (!web || mode == LinkMode.EXTERNAL) return LinkPlan(action, false, LinkMode.EXTERNAL, false)
  return if (customTabsAvailable) LinkPlan(action, true, LinkMode.IN_APP, false)
  else LinkPlan(action, false, LinkMode.EXTERNAL, fallback = mode == LinkMode.IN_APP)
}

/** The framework calls [AndroidUrlOpener] makes, behind a seam so tests need no device. */
internal interface LinkGateway {
  fun customTabsAvailable(): Boolean

  /** The package that would handle the intent, or null when none does. */
  fun handler(intent: Intent): String?

  /** Starts the activity; throws [ActivityNotFoundException] when nothing handles it. */
  fun start(intent: Intent)
}

internal class AndroidUrlOpener(private val gateway: LinkGateway) : UrlOpener {
  override fun open(url: String, mode: LinkMode): LinkOpenResult {
    val plan = linkPlan(url, mode, gateway.customTabsAvailable())
    val intent = linkIntent(url, plan)
    val handler = gateway.handler(intent) ?: return LinkOpenResult.Unavailable
    return try {
      gateway.start(intent)
      LinkOpenResult.Opened(plan.mode, plan.fallback, handler)
    } catch (error: ActivityNotFoundException) {
      // The handler went away between resolving and starting: report it like no handler at all.
      Log.w(TAG, "No activity opened the ${plan.action} link", error)
      LinkOpenResult.Unavailable
    }
  }

  private companion object {
    const val TAG = "PrototypeLinks"
  }
}

/** Custom Tabs protocol constants, so the overlay needs no androidx.browser dependency. */
internal object CustomTabs {
  const val SERVICE_ACTION = "android.support.customtabs.action.CustomTabsService"
  const val EXTRA_SESSION = "android.support.customtabs.extra.SESSION"
}

/** The overlay is not an activity, so every intent starts a new task. */
internal fun linkIntent(url: String, plan: LinkPlan): Intent =
  Intent(plan.action.intentAction, url.toUri()).apply {
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (plan.customTab) {
      // A null session binder is what CustomTabsIntent sends without a bound service.
      putExtras(Bundle().apply { putBinder(CustomTabs.EXTRA_SESSION, null) })
    }
  }

internal class SystemLinkGateway(private val context: Context) : LinkGateway {
  // The overlay registers modules before its context is attached; resolve the manager on use.
  private val packages: PackageManager by lazy { context.packageManager }

  override fun customTabsAvailable(): Boolean =
    packages.queryIntentServices(Intent(CustomTabs.SERVICE_ACTION), 0).isNotEmpty()

  override fun handler(intent: Intent): String? =
    packages.resolveActivity(intent, 0)?.activityInfo?.packageName

  override fun start(intent: Intent) = context.startActivity(intent)
}
