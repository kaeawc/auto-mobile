import Foundation
#if canImport(XCTest) && os(iOS)
    import UIKit
    import XCTest
#endif

extension ElementLocator {
    #if canImport(XCTest) && os(iOS)

        // MARK: - Element Finding

        public func findElement(byResourceId resourceId: String) -> Any? {
            if let cached = elementCache[resourceId] {
                print("[ElementLocator] Element found by resourceId=\(resourceId) source=cache")
                return cached
            }

            let app = currentApplication
            // Query .any first (1 IPC call). If the match is a text-input type,
            // re-query with the specific type to get the outermost (parent) element
            // instead of an internal UIKit subview that shares the same identifier.
            guard let element: XCUIElement = catchingObjCExceptionNonThrowing({
                Self.firstMatchingElement(
                    foregroundLookup: {
                        Self.findElement(in: app, byResourceId: resourceId)
                    },
                    springBoardLookup: {
                        guard self.foregroundBundleId != "com.apple.springboard" else { return nil }
                        return self.findSpringBoardAlertElement(byResourceId: resourceId)
                    }
                )
            }, fallback: nil) else {
                print("[ElementLocator] Element not found by resourceId=\(resourceId)")
                return nil
            }
            elementCache[resourceId] = element
            print("[ElementLocator] Element found by resourceId=\(resourceId) source=query")
            return element
        }

        public func findElement(byText text: String) -> Any? {
            let app = currentApplication
            let element = catchingObjCExceptionNonThrowing({
                Self.firstMatchingElement(
                    foregroundLookup: {
                        Self.findElement(in: app, byText: text)
                    },
                    springBoardLookup: {
                        guard self.foregroundBundleId != "com.apple.springboard" else { return nil }
                        return self.findSpringBoardAlertElement(byText: text)
                    }
                )
            }, fallback: nil)
            if element == nil {
                print("[ElementLocator] Element not found by text=\(text)")
            } else {
                print("[ElementLocator] Element found by text=\(text)")
            }
            return element
        }

        public func findElement(byText text: String, bounds: ElementBounds) -> Any? {
            let app = currentApplication
            return catchingObjCExceptionNonThrowing({
                Self.firstMatchingElement(
                    foregroundLookup: {
                        Self.findElement(in: app, byText: text, matchingBounds: bounds)
                    },
                    springBoardLookup: {
                        guard self.foregroundBundleId != "com.apple.springboard" else { return nil }
                        return self.findSpringBoardAlertElement(byText: text, matchingBounds: bounds)
                    }
                )
            }, fallback: nil)
        }

        private static func findElement(
            in app: XCUIApplication, byText text: String, matchingBounds bounds: ElementBounds
        )
            -> XCUIElement?
        {
            let matches = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", text)).allElementsBoundByIndex
            guard matches.count > 1 else { return matches.first }
            let candidates = (try? app.snapshot()).map { snapshot in
                resolvedFrameCandidates(
                    roots: [snapshot], frame: { $0.frame }, children: { $0.children },
                    matches: { $0.label == text }
                )
            } ?? []
            return closestLiveMatch(matches, candidates: candidates, target: bounds)
        }

        private static func closestLiveMatch(
            _ matches: [XCUIElement], candidates: [FrameCandidate], target: ElementBounds
        )
            -> XCUIElement?
        {
            guard !matches.isEmpty else { return nil }
            guard matches.count > 1 else { return matches.first }
            guard let index = matchingLiveIndex(frames: matches.map(\.frame), candidates: candidates, target: target)
            else { return matches.first }
            return matches[index]
        }

        private static func findElement(in app: XCUIApplication, byResourceId resourceId: String) -> XCUIElement? {
            let anyMatch = app.descendants(matching: .any)
                .matching(identifier: resourceId).firstMatch
            guard anyMatch.exists else { return nil }

            let matchedType = anyMatch.elementType
            if textInputElementTypes.contains(matchedType) {
                let typedMatch = app.descendants(matching: matchedType)
                    .matching(identifier: resourceId).firstMatch
                if typedMatch.exists {
                    return typedMatch
                }
            }
            return anyMatch
        }

        private static func findElement(in app: XCUIApplication, byText text: String) -> XCUIElement? {
            let match = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", text)).firstMatch
            return match.exists ? match : nil
        }

        /// Finds a SpringBoard element only when it belongs to an alert snapshot that
        /// `getAlertsFromSpringboard` would expose through `observe` (#4014).
        private func findSpringBoardAlertElement(byResourceId resourceId: String) -> XCUIElement? {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            guard let snapshot = try? springboard.snapshot() else { return nil }
            let matchingFrames = Self.matchingFrames(
                in: collectAlertElements(from: snapshot),
                matches: { $0.identifier == resourceId }
            )
            return Self.findElement(in: springboard, byResourceId: resourceId, constrainedTo: matchingFrames)
        }

        private func findSpringBoardAlertElement(byText text: String) -> XCUIElement? {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            guard let snapshot = try? springboard.snapshot() else { return nil }
            let matchingFrames = Self.matchingFrames(
                in: collectAlertElements(from: snapshot),
                matches: { $0.label == text }
            )
            return Self.findElement(in: springboard, byText: text, constrainedTo: matchingFrames)
        }

        private func findSpringBoardAlertElement(
            byText text: String,
            matchingBounds bounds: ElementBounds
        )
            -> XCUIElement?
        {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            guard let snapshot = try? springboard.snapshot() else { return nil }
            let candidates = Self.resolvedFrameCandidates(
                roots: collectAlertElements(from: snapshot),
                frame: { $0.frame }, children: { $0.children }, matches: { $0.label == text }
            )
            guard !candidates.isEmpty else { return nil }
            let matches = springboard.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", text)).allElementsBoundByIndex
                .filter { element in
                    candidates.contains {
                        Self.frameDistance($0, element.frame) <= 64
                    }
                }
            return Self.closestLiveMatch(matches, candidates: candidates, target: bounds)
        }

        private static func findElement(
            in app: XCUIApplication,
            byResourceId resourceId: String,
            constrainedTo frames: [CGRect]
        )
            -> XCUIElement?
        {
            guard !frames.isEmpty else {
                return nil
            }
            let matches = app.descendants(matching: .any)
                .matching(identifier: resourceId)
                .allElementsBoundByIndex
            return matches.first { element in
                frames.contains { frame in
                    frame.equalTo(element.frame)
                }
            }
        }

        private static func findElement(
            in app: XCUIApplication,
            byText text: String,
            constrainedTo frames: [CGRect]
        )
            -> XCUIElement?
        {
            guard !frames.isEmpty else {
                return nil
            }
            let matches = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", text))
                .allElementsBoundByIndex
            return matches.first { element in
                frames.contains { frame in
                    frame.equalTo(element.frame)
                }
            }
        }

        private static func matchingFrames(
            in alertSnapshots: [XCUIElementSnapshot],
            matches: (XCUIElementSnapshot) -> Bool
        )
            -> [CGRect]
        {
            alertSnapshots.flatMap { alertSnapshot in
                descendants(of: alertSnapshot).compactMap { snapshot in
                    matches(snapshot) ? snapshot.frame : nil
                }
            }
        }

        private static func descendants(of snapshot: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
            [snapshot] + snapshot.children.flatMap(descendants)
        }
    #endif
}
