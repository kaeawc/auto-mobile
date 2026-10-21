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
        private static let protectedResources: [String: XCUIProtectedResource] = [
            "camera": .camera,
            "photos": .photos,
            "photos-add": .photos,
            "microphone": .microphone,
            "contacts": .contacts,
            "contacts-limited": .contacts,
            "location": .location,
            "location-always": .location,
            "calendar": .calendar,
            "reminders": .reminders,
            "media-library": .mediaLibrary,
            "homekit": .homeKit,
            "focus": .focus,
            "bluetooth": .bluetooth,
            "keyboard-network": .keyboardNetwork,
            "health": .health,
            "user-tracking": .userTracking,
        ]

        /// Map an AutoMobile permission name to the `XCUIProtectedResource` the
        /// runner can reset. Names without an XCUITest equivalent return nil (the
        /// support matrix is advertised honestly — see issue #2491). The mapping is
        /// authoritative here rather than duplicated on the TS host, since
        /// `XCUIProtectedResource` only exists in this process.
        static func protectedResource(for name: String) -> XCUIProtectedResource? {
            if name == "local-network" {
                // Local-network privacy reset is available starting with iOS 15.4.
                if #available(iOS 15.4, *) {
                    return .localNetwork
                }
                return nil
            }
            return protectedResources[name]
        }
    }
#endif
