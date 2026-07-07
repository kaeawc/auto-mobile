import XCTest

final class PrivacyResourceMappingTests: XCTestCase {
    func testProtectedResourceMapsSupportedPermissionNames() {
        let mappings: [(name: String, resource: XCUIProtectedResource)] = [
            ("camera", .camera),
            ("photos", .photos),
            ("photos-add", .photos),
            ("microphone", .microphone),
            ("contacts", .contacts),
            ("contacts-limited", .contacts),
            ("location", .location),
            ("location-always", .location),
            ("calendar", .calendar),
            ("reminders", .reminders),
            ("media-library", .mediaLibrary),
            ("homekit", .homeKit),
            ("focus", .focus),
            ("bluetooth", .bluetooth),
            ("keyboard-network", .keyboardNetwork),
            ("health", .health),
            ("user-tracking", .userTracking),
        ]

        for mapping in mappings {
            XCTAssertEqual(
                GesturePerformer.protectedResource(for: mapping.name),
                mapping.resource,
                "\(mapping.name) should map to \(mapping.resource)"
            )
        }

        if #available(iOS 15.4, *) {
            XCTAssertEqual(
                GesturePerformer.protectedResource(for: "local-network"),
                .localNetwork
            )
        } else {
            XCTAssertNil(GesturePerformer.protectedResource(for: "local-network"))
        }
    }

    func testProtectedResourceRejectsUnsupportedPermissionNames() {
        for name in ["siri", "motion", "unknown-permission"] {
            XCTAssertNil(
                GesturePerformer.protectedResource(for: name),
                "\(name) should not claim an XCUIProtectedResource mapping"
            )
        }
    }

    func testResetPermissionsSurfacesUnsupportedNamesAsStructuredFailures() {
        let commandHandler = CommandHandler.createForTesting(
            elementLocator: PrivacyResourceMappingElementLocator(),
            gesturePerformer: GesturePerformer(elementLocator: PrivacyResourceMappingElementLocator()),
            perfProvider: PerfProvider.createForTesting(timeProvider: FakeTimeProvider(initialTime: 1000))
        )

        for name in ["siri", "motion", "unknown-permission"] {
            let request = WebSocketRequest.resetPermissions(RequestResetPermissions(
                requestId: "reset-\(name)",
                bundleId: "com.example.app",
                permissions: [name]
            ))

            guard let response = commandHandler.handle(request) as? WebSocketResponse else {
                XCTFail("Expected WebSocketResponse for \(name)")
                continue
            }

            XCTAssertEqual(response.type, ResponseType.resetPermissionsResult.rawValue)
            XCTAssertEqual(response.requestId, "reset-\(name)")
            XCTAssertEqual(response.success, false)
            XCTAssertEqual(
                response.error,
                CommandError.invalidParameter("permission", name).localizedDescription
            )
        }
    }
}

private final class PrivacyResourceMappingElementLocator: ElementLocating {
    var foregroundBundleId: String?

    func getViewHierarchy(disableAllFiltering _: Bool) throws -> ViewHierarchy {
        throw CommandError.executionFailed("view hierarchy is not used by privacy resource mapping tests")
    }

    func findElement(byResourceId _: String) -> Any? {
        nil
    }

    func findElement(byText _: String) -> Any? {
        nil
    }

    func trackObservedBundleId(_: String) {}

    func switchForegroundApp(bundleId: String) {
        foregroundBundleId = bundleId
    }

    func getAppState(bundleId _: String) -> ObservedAppState {
        .unknown
    }

    func awaitAppState(bundleId _: String, expectedState _: AppStateExpectation) -> Bool {
        false
    }
}
