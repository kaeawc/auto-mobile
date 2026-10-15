import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

#if canImport(XCTest) && os(iOS)
    extension GesturePerformer {
        /// Map an AutoMobile permission name to the `XCUIProtectedResource` the
        /// runner can reset. Names without an XCUITest equivalent return nil (the
        /// support matrix is advertised honestly — see issue #2491). The mapping is
        /// authoritative here rather than duplicated on the TS host, since
        /// `XCUIProtectedResource` only exists in this process.
        static func protectedResource(for name: String) -> XCUIProtectedResource? {
            switch name {
            case "camera": return .camera
            case "photos", "photos-add": return .photos
            case "microphone": return .microphone
            case "contacts", "contacts-limited": return .contacts
            case "location", "location-always": return .location
            case "calendar": return .calendar
            case "reminders": return .reminders
            case "media-library": return .mediaLibrary
            case "homekit": return .homeKit
            case "focus": return .focus
            case "bluetooth": return .bluetooth
            case "keyboard-network": return .keyboardNetwork
            case "health": return .health
            case "user-tracking": return .userTracking
            case "local-network":
                // `XCUIProtectedResourceLocalNetwork` is iOS 15.4+ only. Below that
                // OS version there is no resettable equivalent, so return nil and let
                // the caller surface an honest per-permission failure instead of
                // silently skipping it.
                if #available(iOS 15.4, *) {
                    return .localNetwork
                }
                return nil
            default: return nil
            }
        }
    }
#endif
