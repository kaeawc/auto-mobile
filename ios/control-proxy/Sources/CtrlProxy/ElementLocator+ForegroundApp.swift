import Foundation
#if canImport(XCTest) && os(iOS)
    import UIKit
    import XCTest
#endif

extension ElementLocator {
    #if canImport(XCTest) && os(iOS)
        /// Safety-net detection: re-detect the foreground app if the current tracking seems stale.
        /// With explicit transitions via switchForegroundApp, this should rarely fire.
        func ensureForegroundApp() {
            // If we recently did an explicit switch, trust it — the caller already set the right app
            let nsSinceSwitch = DispatchTime.now().uptimeNanoseconds - tracker.lastSwitchTime
            let msSinceSwitch = nsSinceSwitch / 1_000_000
            if msSinceSwitch < 200 {
                return
            }

            // Snapshot the tracked bundle id once.
            let trackedBundleId = tracker.bundleId

            // IMPORTANT: Create fresh XCUIApplication instances to check state, because
            // cached instances may return stale state values
            let stateInfo: (springboardState: UInt, currentAppState: UInt?, currentBundleId: String?) =
                tracked("checkState") {
                    catchingObjCExceptionNonThrowing({
                        let sbState = self.springboard.state.rawValue
                        let freshAppState: UInt? = trackedBundleId.map { bundleId in
                            XCUIApplication(bundleIdentifier: bundleId).state.rawValue
                        }
                        return (sbState, freshAppState, trackedBundleId)
                    }, fallback: (0, nil, trackedBundleId))
                }

            let isCurrentAppInForeground = (stateInfo.currentAppState ?? 0) >=
                4 // .runningForeground only (3 = .runningBackground)
            let isCurrentAppSpringboard = stateInfo.currentBundleId == "com.apple.springboard"

            if appSwitcherMayBeVisible {
                let switcherVisible = stateInfo.springboardState >= 3 &&
                    catchingObjCExceptionNonThrowing({
                        AppSwitcherDetector.isVisible(in: springboard)
                    }, fallback: false)
                if Self.foregroundBundleId(
                    from: trackedBundleId.map { [$0] } ?? [],
                    springboardRunning: stateInfo.springboardState >= 3,
                    switcherVisible: switcherVisible
                ) == "com.apple.springboard" {
                    if tracker.bundleId != "com.apple.springboard" {
                        switchForegroundApp(bundleId: "com.apple.springboard")
                        appSwitcherMayBeVisible = true
                    }
                    return
                }
                // A dismissed switcher must not keep the previous app hidden.
                appSwitcherMayBeVisible = false
            }

            // Springboard reports as foreground even when another app is on top,
            // so we always re-detect unless a non-springboard app is confirmed foreground
            if isCurrentAppInForeground, !isCurrentAppSpringboard {
                tracker.didFallbackToSpringboard = false
                return
            }

            if let detectedBundleId = tracked("detectForeground", { detectForegroundAppBundleId() }) {
                if detectedBundleId != tracker.bundleId {
                    switchForegroundApp(bundleId: detectedBundleId)
                }
                tracker.didFallbackToSpringboard = false
            } else if !isCurrentAppInForeground {
                if tracker.bundleId != "com.apple.springboard" {
                    switchForegroundApp(bundleId: "com.apple.springboard")
                    tracker.didFallbackToSpringboard = true
                }
            }
        }

        /// Get the current application to observe
        /// Returns foreground app if available and in foreground, otherwise springboard
        var currentApplication: XCUIApplication {
            let appObject = tracker.app
            let trackedBundleId = tracker.bundleId
            let trackedApp = appObject as? XCUIApplication
            // Check state on main thread using fresh instance (cached instances return stale state)
            let freshState: UInt? = catchingObjCExceptionNonThrowing({
                trackedBundleId.map { bundleId in
                    XCUIApplication(bundleIdentifier: bundleId).state.rawValue
                }
            }, fallback: nil)
            let foregroundAppInForeground = (freshState ?? 0) >= 4 // .runningForeground only
            if let app = trackedApp, foregroundAppInForeground {
                return app
            }
            return springboard
        }

        /// Common system apps to check when detecting foreground app
        /// These are apps that might be launched by the user during testing
        private static let commonSystemApps: [String] = [
            "com.apple.Preferences", // Settings
            "com.apple.mobilesafari", // Safari
            "com.apple.MobileAddressBook", // Contacts
            "com.apple.mobilephone", // Phone
            "com.apple.MobileSMS", // Messages
            "com.apple.Spotlight", // Spotlight search
            "com.apple.mobileslideshow", // Photos
            "com.apple.camera", // Camera
            "com.apple.AppStore", // App Store
            "com.apple.Maps", // Maps
            "com.apple.Health", // Health
            "com.apple.Fitness", // Fitness
            "com.apple.weather", // Weather
            "com.apple.mobilenotes", // Notes
            "com.apple.reminders", // Reminders
            "com.apple.mobilecal", // Calendar
            "com.apple.mobilemail", // Mail
            "com.apple.Music", // Music
            "com.apple.Podcasts", // Podcasts
            "com.apple.TV", // TV
            "com.apple.news", // News
            "com.apple.stocks", // Stocks
            "com.apple.tips", // Tips
            "com.apple.iBooks", // Books
            "com.apple.DocumentsApp", // Files
            "com.apple.calculator", // Calculator
            "com.apple.VoiceMemos", // Voice Memos
            "com.apple.compass", // Compass
            "com.apple.measure", // Measure
            "com.apple.facetime", // FaceTime
            "com.apple.Home", // Home
            "com.apple.shortcuts", // Shortcuts
            "com.apple.Translate", // Translate
            "com.apple.Magnifier", // Magnifier
            "com.apple.clock", // Clock
            "com.apple.findmy", // Find My
            "com.apple.Passbook", // Wallet
            "dev.jasonpearson.automobile.Playground", // AutoMobile Playground app
        ]

        /// Detect the bundle ID of the foreground app
        /// Returns nil if detection fails or springboard is in front
        private func detectForegroundAppBundleId() -> String? {
            // Snapshot the foreground/observed state once so the loops iterate a stable copy.
            let currentBundleId = tracker.bundleId
            let observedBundleIds = tracker.observedBundleIds

            // Spotlight owns its accessibility hierarchy. SpringBoard's snapshot
            // exposes only the status bar while Spotlight is foreground.
            if let preferredSystemSurface = Self.preferredSystemSurfaceBundleId(
                trackedBundleId: currentBundleId,
                spotlightStateRaw: catchingObjCExceptionNonThrowing({
                    XCUIApplication(bundleIdentifier: Self.spotlightBundleId).state.rawValue
                }, fallback: 0)
            ) {
                return preferredSystemSurface
            }

            // First, try to find bundle IDs from springboard's element tree
            // This can work when apps embed their bundle ID in element identifiers
            let snapshot: XCUIElementSnapshot? = tracked("springboardSnapshot") {
                catchingObjCExceptionNonThrowing({
                    try? self.springboard.snapshot()
                }, fallback: nil)
            }

            if let snapshot = snapshot {
                let result: String? = tracked("checkCandidates") {
                    var candidateBundleIds: [String] = []
                    collectBundleIdsFromElement(snapshot, into: &candidateBundleIds)

                    for bundleId in candidateBundleIds {
                        if bundleId == "com.apple.springboard" {
                            continue
                        }

                        let stateRawValue: UInt = catchingObjCExceptionNonThrowing({
                            let testApp = XCUIApplication(bundleIdentifier: bundleId)
                            return testApp.state.rawValue
                        }, fallback: 0)
                        if stateRawValue >= 4 { // .runningForeground only
                            return bundleId
                        }
                    }
                    return nil
                }
                if let foundBundleId = result {
                    return foundBundleId
                }
            } else {
                print("[ElementLocator] Failed to snapshot springboard while detecting foreground app")
            }

            // Fallback: Check observed bundle IDs first (apps we've seen before)
            let observedResult: String? = tracked("checkObserved") {
                for bundleId in observedBundleIds {
                    // Skip current app (we already know it's not in foreground)
                    if bundleId == currentBundleId {
                        continue
                    }

                    let stateRawValue: UInt = catchingObjCExceptionNonThrowing({
                        let testApp = XCUIApplication(bundleIdentifier: bundleId)
                        return testApp.state.rawValue
                    }, fallback: 0)
                    if stateRawValue >= 4 { // .runningForeground only
                        return bundleId
                    }
                }
                return nil
            }
            if let found = observedResult {
                return found
            }

            // Fallback: Check common system apps directly
            // This is necessary because when another app is in foreground,
            // springboard's element tree may not contain that app's bundle ID.
            //
            // This is the last-resort path: the SpringBoard card tree and the
            // observed bundle ids above are the primary candidates. Walking all
            // ~40 static ids is ~40 sequential state IPCs on the app's main
            // thread, so a recent miss is cached briefly to avoid repeating the
            // full fan-out on every extraction (issue #5474).
            return tracked("checkSystemApps") {
                let now = DispatchTime.now().uptimeNanoseconds
                guard Self.shouldRunSystemAppSweep(
                    now: now,
                    lastMissTime: tracker.lastSystemAppSweepMiss,
                    ttlNanos: Self.systemAppSweepMissTtlNanos
                ) else {
                    return nil
                }

                for bundleId in Self.commonSystemApps {
                    // Skip current app (we already know it's not in foreground)
                    if bundleId == currentBundleId {
                        continue
                    }
                    // Skip already checked in observedBundleIds
                    if observedBundleIds.contains(bundleId) {
                        continue
                    }

                    let stateRawValue: UInt = catchingObjCExceptionNonThrowing({
                        let testApp = XCUIApplication(bundleIdentifier: bundleId)
                        return testApp.state.rawValue
                    }, fallback: 0)
                    if stateRawValue >= 4 { // .runningForeground only
                        return bundleId
                    }
                }
                // No foreground system app found — cache this negative result so
                // the next extraction within the TTL skips the full sweep.
                tracker.lastSystemAppSweepMiss = now
                return nil
            }
        }

        /// TTL for the `checkSystemApps` negative-result cache (issue #5474).
        /// The hierarchy debouncer runs regularly, so bounding the miss path to at
        /// most one full sweep per second dampens the ~40-IPC fan-out without
        /// meaningfully delaying detection of a genuine foreground change (which
        /// also resets the cache via `switchForegroundApp`).
        private static let systemAppSweepMissTtlNanos: UInt64 = 1_000_000_000

        /// Collect all potential bundle IDs from springboard element tree
        private func collectBundleIdsFromElement(
            _ element: XCUIElementSnapshot,
            into bundleIds: inout [String],
            depth: Int = 0
        ) {
            if let bundleId = Self.bundleIdFromSpringboardIdentifier(element.identifier),
               !bundleIds.contains(bundleId)
            {
                bundleIds.append(bundleId)
            }

            // Recursively check children
            for child in element.children {
                collectBundleIdsFromElement(child, into: &bundleIds, depth: depth + 1)
            }
        }
    #endif
}
