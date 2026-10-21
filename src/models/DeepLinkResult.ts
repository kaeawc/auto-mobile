export interface IntentFilter {
  action: string;
  category: string[];
  data?: {
    scheme?: string;
    host?: string;
    port?: string;
    path?: string;
    pathPattern?: string;
    pathPrefix?: string;
    mimeType?: string;
  }[];
}

export interface DeepLinkInfo {
  schemes: string[];
  hosts: string[];
  intentFilters: IntentFilter[];
  supportedMimeTypes: string[];
}

/**
 * One web domain's Android App Links state for a package (#14110), read from
 * `pm get-app-links --user <id> <pkg>` on Android 12 (API 31) and newer.
 */
export interface AppLinkDomainState {
  domain: string;
  /**
   * Android's domain verification state as `pm get-app-links` prints it: `none`, `verified`,
   * `approved`, `denied`, `migrated`, `restored`, `legacy_failure`, `system_configured`,
   * `pre_verified`, or a numeric verifier error code (>= 1024). Absent for a domain the app
   * declares without `android:autoVerify`, which Android never verifies.
   */
  state?: string;
  /** The domain is declared in an `android:autoVerify="true"` intent filter. */
  autoVerify: boolean;
  /** The user enabled this domain for the app (Settings > Open by default > Add link). */
  userSelected: boolean;
  /**
   * The app may open links to this domain without a chooser: a verified-equivalent state or a
   * user selection, with link handling allowed. Another app approved for the same domain can
   * still win.
   */
  approvedForLinks: boolean;
}

export interface DeepLinkResult {
  success: boolean;
  appId: string;
  deepLinks: DeepLinkInfo;
  rawOutput?: string;
  error?: string;
  note?: string;
  /** Android 12+: per-domain App Links state for {@link appLinksUserId}. */
  appLinks?: AppLinkDomainState[];
  appLinksUserId?: number;
  /** False when the user turned off "Open supported links" for the app. */
  appLinkHandlingAllowed?: boolean;
  /** Why `appLinks` is absent (pre-Android 12 device, unreadable state); never fails the read. */
  appLinksUnavailable?: string;
}

/**
 * Minimal shape of an iOS app's `Info.plist` relevant to deep-link discovery.
 * Custom URL schemes are declared under `CFBundleURLTypes`; document/MIME types
 * under `CFBundleDocumentTypes`. Universal-link hosts are NOT here — they live in
 * the code-signing entitlements (`com.apple.developer.associated-domains`).
 */
export interface IosInfoPlist {
  CFBundleURLTypes?: { CFBundleURLName?: string; CFBundleURLSchemes?: string[] }[];
  CFBundleDocumentTypes?: { LSItemContentTypes?: string[] }[];
  LSApplicationQueriesSchemes?: string[];
}
