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

export interface DeepLinkResult {
  success: boolean;
  appId: string;
  deepLinks: DeepLinkInfo;
  rawOutput?: string;
  error?: string;
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
