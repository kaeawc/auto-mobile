import Foundation
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

extension CommandHandler {
    // MARK: - Accessibility Features

    /// Report the element holding the VoiceOver cursor. The cursor is only visible in-process,
    /// so it reaches us as `accessibility-focused` on the SDK-enriched hierarchy (see
    /// HierarchyMerger, #3924). A null focusedElement is a success, not an error.
    func handleGetCurrentFocus(
        _ request: RequestEnvelope,
        startTime: Date
    )
        async throws -> CurrentFocusResponse
    {
        let enriched = try await enrichedHierarchyForAccessibility()
        let focused = enriched.hierarchy.flatMap { Self.findAccessibilityFocused($0) }
        return CurrentFocusResponse(
            requestId: request.requestId,
            focusedElement: focused,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// Report accessibility elements in VoiceOver traversal (depth-first) order, plus the
    /// index of the focused one when the cursor is present (#3924).
    func handleGetTraversalOrder(
        _ request: RequestEnvelope,
        startTime: Date
    )
        async throws -> TraversalOrderResponse
    {
        let enriched = try await enrichedHierarchyForAccessibility()
        var ordered: [UIElementInfo] = []
        if let root = enriched.hierarchy {
            Self.collectAccessibilityElements(root, into: &ordered)
        }
        let focusedIndex = ordered.firstIndex { $0.accessibilityFocused == "true" }
        return TraversalOrderResponse(
            requestId: request.requestId,
            elements: ordered,
            focusedIndex: focusedIndex,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// Extract the hierarchy and merge the in-app SDK view tree into it, so accessibility-only
    /// signals (the VoiceOver cursor, `isAccessibilityElement`) are present.
    private func enrichedHierarchyForAccessibility() async throws -> ViewHierarchy {
        let hierarchy: ViewHierarchy
        do {
            hierarchy = try await trackedAsync("extraction") {
                try await self.captureHierarchy()
            }
        } catch {
            throw CommandError.executionFailed("Failed to get view hierarchy: \(error.localizedDescription)")
        }
        return await enrichWithMatchingSdkHierarchy(hierarchy)
    }

    /// Depth-first search for the element carrying the VoiceOver cursor.
    static func findAccessibilityFocused(_ element: UIElementInfo) -> UIElementInfo? {
        if element.accessibilityFocused == "true" {
            return element
        }
        for child in element.node ?? [] {
            if let match = findAccessibilityFocused(child) {
                return match
            }
        }
        return nil
    }

    /// Collect, depth-first, the elements VoiceOver would stop on. `isAccessibilityElement`
    /// is the precise signal, carried through from the in-app SDK; containers that merely
    /// hold other elements are skipped but still traversed into.
    static func collectAccessibilityElements(_ element: UIElementInfo, into ordered: inout [UIElementInfo]) {
        if element.extras?["sdk.isAccessibilityElement"] == "true" {
            ordered.append(element)
        }
        for child in element.node ?? [] {
            collectAccessibilityElements(child, into: &ordered)
        }
    }

    func handleAddHighlight(_ request: RequestAddHighlight, startTime: Date) async -> WebSocketResponse {
        guard let shape = request.shape else {
            return WebSocketResponse.error(
                type: ResponseType.highlightResponse.rawValue,
                requestId: request.requestId,
                error: "add_highlight requires a shape",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        let highlightId = request.id ?? request.requestId ?? UUID().uuidString
        // When the in-app SDK bridge owns the foreground app, it is the authoritative (and
        // only) highlight path. A rejection there — e.g. missing source dimensions (#2682) —
        // must be reported precisely rather than collapsed into the generic "SDK not embedded"
        // error below, which would mislead since the SDK is in fact embedded. An unreachable
        // bridge falls through to that generic error.
        if sdkHierarchyClient != nil, await sdkServerMatchesTrackedForegroundApp() {
            switch await sdkHierarchyClient?.addHighlight(id: highlightId, shape: shape) {
            case .rendered:
                return WebSocketResponse.success(
                    type: ResponseType.highlightResponse.rawValue,
                    requestId: request.requestId,
                    totalTimeMs: totalTimeMs(from: startTime)
                )
            case .rejected:
                return WebSocketResponse.error(
                    type: ResponseType.highlightResponse.rawValue,
                    requestId: request.requestId,
                    error: "Target app SDK highlight bridge rejected the highlight "
                        + "(missing source dimensions or invalid shape).",
                    totalTimeMs: totalTimeMs(from: startTime)
                )
            case .unavailable, .none:
                break // Bridge unreachable — fall through to the SDK-required error.
            }
        }
        // iOS cannot draw an overlay into another app from the test runner: the runner's own
        // UIWindow only composites while the runner is foreground, which never happens during
        // automation. Highlighting the app-under-test requires the in-app AutoMobile SDK bridge.
        let foregroundBundleId = await elementLocator.foregroundBundleId ?? "the foreground app"
        return WebSocketResponse.error(
            type: ResponseType.highlightResponse.rawValue,
            requestId: request.requestId,
            error: "Highlighting \(foregroundBundleId) requires the AutoMobile SDK embedded in the target app; "
                + "iOS cannot draw an overlay into another app from the test runner.",
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleGetVoiceOverState(
        _ request: RequestEnvelope,
        startTime: Date
    )
        async -> VoiceOverStateResponse
    {
        guard let enabled = voiceOverStateProvider.isVoiceOverRunning() else {
            return VoiceOverStateResponse(
                requestId: request.requestId,
                unreadableWithTotalTimeMs: totalTimeMs(from: startTime)
            )
        }

        return VoiceOverStateResponse(
            requestId: request.requestId,
            enabled: enabled,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// Enable/disable VoiceOver on a physical device by driving Settings (#2501).
    /// The toggle reads the switch value and skips the tap when it already matches.
    func handleSetVoiceOverState(
        _ request: RequestSetVoiceOverState,
        startTime: Date
    )
        async -> VoiceOverSetResponse
    {
        let enabled = request.enabled

        return await respond(requestId: request.requestId, startTime: startTime) {
            // `setVoiceOver` is `@MainActor` (it drives XCUITest); `await` hops this async
            // `Sendable` handler onto the main actor, like its other UI-collaborator calls.
            try await voiceOverToggle.setVoiceOver(enabled: enabled)
            return VoiceOverSetResponse(
                requestId: request.requestId,
                success: true,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    func handleSetHingeAngle(
        _ request: RequestSetHingeAngle,
        startTime: Date
    )
        async -> HingeAngleResponse
    {
        return await respond(requestId: request.requestId, startTime: startTime) {
            guard request.angle.isFinite, (0 ... 180).contains(request.angle) else {
                throw VerbatimLocalizedError(message: "Hinge angle must be a finite number from 0 to 180 degrees.")
            }
            try await hingeAngleSetter.setHingeAngle(request.angle)
            return HingeAngleResponse(
                requestId: request.requestId,
                success: true,
                angle: request.angle,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }
}

// MARK: - Native accessibility audit (#14086)

extension CommandHandler {
    /// Run XCUITest's own accessibility audit on the requested (or foreground) app and return
    /// every issue it reports. Unknown check names are reported back, not fatal.
    func handleAccessibilityAudit(
        _ request: RequestAccessibilityAudit,
        startTime: Date
    )
        async -> AccessibilityAuditResponse
    {
        let requested = request.checks ?? []
        let names = requested.isEmpty || requested.contains("all") ? AccessibilityAuditCheck.all : requested
        let known = names.filter { AccessibilityAuditCheck.all.contains($0) }
        let unknown = names.filter { !AccessibilityAuditCheck.all.contains($0) }
        var bundleId = request.appId
        if bundleId?.isEmpty ?? true {
            bundleId = await elementLocator.foregroundBundleId
        }
        let outcome = known.isEmpty
            ? AccessibilityAuditOutcome(issues: [], unsupportedChecks: [], error: nil)
            : await accessibilityAuditor.audit(bundleId: bundleId, checks: known)
        return AccessibilityAuditResponse(
            requestId: request.requestId,
            issues: outcome.issues,
            unsupportedChecks: unknown + outcome.unsupportedChecks,
            error: outcome.error,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }
}

/// The host-facing names of XCUITest's `XCUIAccessibilityAuditType` checks.
enum AccessibilityAuditCheck {
    static let all = [
        "contrast", "hitRegion", "dynamicType", "textClipped", "sufficientDescription", "trait",
        "elementDetection",
    ]
}

/// `request_accessibility_audit`: audit an app with XCUITest's `performAccessibilityAudit`.
public struct RequestAccessibilityAudit: Decodable, Sendable {
    public var requestId: String?
    /// The app to audit; the tracked foreground app when absent.
    public var appId: String?
    /// Host check names; absent, empty, or containing `all` runs every check.
    public var checks: [String]?
}

extension RequestAccessibilityAudit: CommandPayload {}

/// One issue XCUITest's accessibility audit reported, with the offending element when known.
public struct AccessibilityAuditIssue: Encodable, Sendable {
    public let check: String
    public let summary: String
    public let detail: String?
    /// The element's accessibility identifier: the id `tapOn`/`highlight` accept.
    public let elementId: String?
    public let label: String?
    public let bounds: ElementBounds?

    public init(
        check: String, summary: String, detail: String?, elementId: String?, label: String?,
        bounds: ElementBounds?
    ) {
        self.check = check
        self.summary = summary
        self.detail = detail
        self.elementId = elementId
        self.label = label
        self.bounds = bounds
    }
}

public struct AccessibilityAuditOutcome: Sendable {
    public let issues: [AccessibilityAuditIssue]
    /// Checks this OS or Xcode could not run.
    public let unsupportedChecks: [String]
    public let error: String?

    public init(issues: [AccessibilityAuditIssue], unsupportedChecks: [String], error: String?) {
        self.issues = issues
        self.unsupportedChecks = unsupportedChecks
        self.error = error
    }
}

/// Runs the platform accessibility audit; injected so the command handler is testable off-device.
public protocol AccessibilityAuditing: Sendable {
    func audit(bundleId: String?, checks: [String]) async -> AccessibilityAuditOutcome
}

public struct AccessibilityAuditResponse: Encodable, Sendable {
    public let type = ResponseType.accessibilityAuditResult.rawValue
    public let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
    public let engine = "xcuitest"
    public let requestId: String?
    public let success: Bool
    public let issues: [AccessibilityAuditIssue]
    public let unsupportedChecks: [String]
    public let error: String?
    public let totalTimeMs: Int64

    init(
        requestId: String?, issues: [AccessibilityAuditIssue], unsupportedChecks: [String], error: String?,
        totalTimeMs: Int64
    ) {
        self.requestId = requestId
        success = error == nil
        self.issues = issues
        self.unsupportedChecks = unsupportedChecks
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}

/// Production `AccessibilityAuditing`: `XCUIApplication.performAccessibilityAudit` (iOS 17+).
struct DefaultAccessibilityAuditor: AccessibilityAuditing {
    func audit(bundleId: String?, checks: [String]) async -> AccessibilityAuditOutcome {
        #if canImport(XCTest) && os(iOS)
            return await MainActor.run { Self.runAudit(bundleId: bundleId, checks: checks) }
        #else
            return AccessibilityAuditOutcome(
                issues: [], unsupportedChecks: checks,
                error: "Accessibility audits need XCUITest on iOS"
            )
        #endif
    }
}

#if canImport(XCTest) && os(iOS)
    /// Collects issues from the audit's issue handler; written only on the main actor during the
    /// synchronous audit call and read after it returns.
    private final class AccessibilityAuditCollector: @unchecked Sendable {
        var issues: [AccessibilityAuditIssue] = []
    }

    extension DefaultAccessibilityAuditor {
        private static let auditTypes: [(name: String, type: XCUIAccessibilityAuditType)] = [
            ("contrast", .contrast),
            ("hitRegion", .hitRegion),
            ("dynamicType", .dynamicType),
            ("textClipped", .textClipped),
            ("sufficientDescription", .sufficientElementDescription),
            ("trait", .trait),
            ("elementDetection", .elementDetection),
        ]

        @MainActor
        static func runAudit(bundleId: String?, checks: [String]) -> AccessibilityAuditOutcome {
            guard let bundleId, !bundleId.isEmpty else {
                return AccessibilityAuditOutcome(
                    issues: [], unsupportedChecks: [],
                    error: "No foreground app to audit; launch the app or pass appId"
                )
            }
            var types: XCUIAccessibilityAuditType = []
            for entry in auditTypes where checks.contains(entry.name) {
                types.insert(entry.type)
            }
            let collector = AccessibilityAuditCollector()
            do {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                try catchingObjCException {
                    try app.performAccessibilityAudit(for: types) { issue in
                        collector.issues.append(Self.describe(issue))
                        // Returning true marks the issue handled, so the audit collects every
                        // issue instead of recording a test failure for it.
                        return true
                    }
                }
            } catch {
                return AccessibilityAuditOutcome(
                    issues: collector.issues, unsupportedChecks: [],
                    error: "Accessibility audit of \(bundleId) failed: \(error.localizedDescription)"
                )
            }
            return AccessibilityAuditOutcome(issues: collector.issues, unsupportedChecks: [], error: nil)
        }

        @MainActor
        private static func describe(_ issue: XCUIAccessibilityAuditIssue) -> AccessibilityAuditIssue {
            let check = auditTypes.first { $0.type == issue.auditType }?.name ?? "other"
            let snapshot = issue.element.flatMap { element in
                try? catchingObjCException { try element.snapshot() }
            }
            let bounds = snapshot.map { ElementBounds(clamping: $0.frame) }
            let identifier = snapshot?.identifier ?? ""
            let label = snapshot?.label ?? ""
            return AccessibilityAuditIssue(
                check: check,
                summary: issue.compactDescription,
                detail: issue.detailedDescription.isEmpty ? nil : issue.detailedDescription,
                elementId: identifier.isEmpty ? nil : identifier,
                label: label.isEmpty ? nil : label,
                bounds: bounds
            )
        }
    }
#endif
