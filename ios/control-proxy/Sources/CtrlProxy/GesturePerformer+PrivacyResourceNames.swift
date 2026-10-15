import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

extension GesturePerformer {
    /// Every AutoMobile permission name that maps to a resettable iOS
    /// `XCUIProtectedResource` (Xcode 26.3 header). The `all` keyword expands to
    /// this list; the TS host list in `IosPhysicalPermissions.ts`
    /// (`IOS_PHYSICAL_RESET_ALL_PERMISSIONS`) must stay in lock-step so the public
    /// tool path and the direct runner path reset the identical set.
    /// `local-network` is iOS 15.4+ only; below that OS version
    /// `protectedResource(for:)` returns nil so it fails honestly per-permission
    /// rather than being silently skipped.
    nonisolated static let allResettablePrivacyResourceNames = [
        "camera",
        "photos",
        "microphone",
        "contacts",
        "location",
        "calendar",
        "reminders",
        "media-library",
        "homekit",
        "focus",
        "local-network",
        "bluetooth",
        "keyboard-network",
        "health",
        "user-tracking",
    ]

    private nonisolated static let resettablePrivacyResourceAliases = Set(
        allResettablePrivacyResourceNames + [
            "photos-add",
            "contacts-limited",
            "location-always",
        ]
    )

    nonisolated static func canonicalPrivacyResourceName(for name: String) -> String {
        switch name {
        case "photos-add": return "photos"
        case "contacts-limited": return "contacts"
        case "location-always": return "location"
        default: return name
        }
    }

    nonisolated static func expandedPrivacyResourceNames(for name: String) -> [String]? {
        if name == "all" {
            return allResettablePrivacyResourceNames
        }
        if resettablePrivacyResourceAliases.contains(name) {
            return [name]
        }
        return nil
    }
}
