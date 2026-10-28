@testable import AutoMobileSDK
import AutoMobileSdkWire
import XCTest

/// #5160: one registration call per network transport family, reported as capability descriptors.
final class HostTransportRegistryTests: XCTestCase {
    override func tearDown() {
        AutoMobileNetwork.shared.hostTransports.reset()
        super.tearDown()
    }

    private func descriptor(
        _ transport: HostTransport,
        registered: Bool,
        initialized: Bool = true,
        enabled: Bool = true,
        faultRules: Bool = true
    )
        -> SdkCapabilityDescriptor
    {
        HostTransportRegistry.descriptor(
            for: transport,
            registered: registered,
            networkInitialized: initialized,
            networkEnabled: enabled,
            faultRulesAvailable: faultRules
        )
    }

    func testUnregisteredTransportIsHostOptInNeverSupported() {
        for transport in [HostTransport.urlSession, .backgroundURLSession, .webSocket, .nwConnection] {
            let result = descriptor(transport, registered: false)
            XCTAssertEqual(result.state, .disabled, transport.rawValue)
            XCTAssertEqual(result.reason, "HOST_OPT_IN", transport.rawValue)
            XCTAssertEqual(result.faultEnforcement, SdkFaultEnforcement.notEnforceable, transport.rawValue)
        }
    }

    func testRegisteredURLSessionIsSupportedAndEnforcesFaults() {
        XCTAssertEqual(
            descriptor(.urlSession, registered: true),
            SdkCapabilityDescriptor(
                id: "network.transport.urlsession", state: .supported, reason: nil, faultEnforcement: .enforced,
                faultActions: ["closeConnection", "dropBytes", "error", "latency", "response", "status"]
            )
        )
    }

    func testRegisteredWebSocketAndNWConnectionEnforceDelayAndFail() {
        for transport in [HostTransport.webSocket, .nwConnection] {
            let result = descriptor(transport, registered: true)
            XCTAssertEqual(result.state, .supported, transport.rawValue)
            XCTAssertEqual(result.faultEnforcement, .enforced, transport.rawValue)
            XCTAssertEqual(result.faultActions, ["closeConnection", "error", "latency"], transport.rawValue)
        }
    }

    func testRegisteredBackgroundSessionOnlyEvaluatesFaults() {
        let result = descriptor(.backgroundURLSession, registered: true)
        XCTAssertEqual(result.state, .supported)
        XCTAssertEqual(result.faultEnforcement, .evaluateOnly)
        XCTAssertEqual(result.faultActions, [])
    }

    func testWithoutFaultRulesNoTransportEnforces() {
        let result = descriptor(.urlSession, registered: true, faultRules: false)
        XCTAssertEqual(result.faultEnforcement, SdkFaultEnforcement.notEnforceable)
    }

    func testOtherTransportsAreAlwaysUnsupported() {
        let result = descriptor(.other, registered: true)
        XCTAssertEqual(result.state, .unsupported)
        XCTAssertEqual(result.reason, "NO_ADAPTER")
    }

    func testCaptureStateOutranksRegistration() {
        XCTAssertEqual(descriptor(.urlSession, registered: true, initialized: false).state, .notInitialized)
        let disabled = descriptor(.urlSession, registered: true, enabled: false)
        XCTAssertEqual(disabled.state, .disabled)
        XCTAssertEqual(disabled.reason, "NETWORK_CAPTURE_DISABLED")
    }

    func testDescriptorsCoverEveryTransportInOrder() {
        let registry = HostTransportRegistry()
        registry.register(.webSocket)
        let ids = registry.descriptors(networkInitialized: true, networkEnabled: true, faultRulesAvailable: true)
            .map(\.id)
        XCTAssertEqual(ids, HostTransport.allCases.map(\.rawValue))
        XCTAssertTrue(registry.isRegistered(.webSocket))
        XCTAssertFalse(registry.isRegistered(.urlSession))
    }

    func testRegisterURLSessionInstallsTheProtocolOnceAndFirst() {
        let configuration = URLSessionConfiguration.ephemeral
        let first = AutoMobileNetwork.shared.registerURLSession(configuration)
        AutoMobileNetwork.shared.registerURLSession(configuration)

        let protocolId = ObjectIdentifier(AutoMobileNetwork.shared.protocolClass())
        let classes = configuration.protocolClasses ?? []
        XCTAssertEqual(classes.filter { ObjectIdentifier($0) == protocolId }.count, 1)
        XCTAssertEqual(classes.first.map { ObjectIdentifier($0) }, protocolId)
        XCTAssertEqual(first.mode, .urlProtocol)
        XCTAssertNil(first.adapter, "a URLProtocol session has no adapter to record a request twice")
        XCTAssertTrue(AutoMobileNetwork.shared.hostTransports.isRegistered(.urlSession))
    }

    func testRegisterBackgroundURLSessionLeavesTheConfigurationAndReturnsAnAdapter() {
        let configuration = URLSessionConfiguration.background(withIdentifier: "dev.automobile.tests.background")
        let before = (configuration.protocolClasses ?? []).map { ObjectIdentifier($0) }

        let registration = AutoMobileNetwork.shared.registerURLSession(configuration)

        XCTAssertEqual((configuration.protocolClasses ?? []).map { ObjectIdentifier($0) }, before)
        XCTAssertEqual(registration.transport, .backgroundURLSession)
        XCTAssertEqual(registration.mode, .delegateForwarding)
        XCTAssertNotNil(registration.adapter)
        XCTAssertTrue(AutoMobileNetwork.shared.hostTransports.isRegistered(.backgroundURLSession))
        XCTAssertFalse(AutoMobileNetwork.shared.hostTransports.isRegistered(.urlSession))
    }

    func testRegisterWebSocketAndNWConnectionMarkTheirFamilies() {
        _ = AutoMobileNetwork.shared.registerWebSocket()
        _ = AutoMobileNetwork.shared.registerNWConnection()
        XCTAssertTrue(AutoMobileNetwork.shared.hostTransports.isRegistered(.webSocket))
        XCTAssertTrue(AutoMobileNetwork.shared.hostTransports.isRegistered(.nwConnection))
    }

    func testUnknownStateDecodesAsUnknown() throws {
        let json = Data(#"{"id":"x","state":"FUTURE_STATE"}"#.utf8)
        let decoded = try JSONDecoder().decode(SdkCapabilityDescriptor.self, from: json)
        XCTAssertEqual(decoded.state, .unknown)
        XCTAssertNil(decoded.faultEnforcement)
    }

    func testDescriptorEncodesTheAndroidStateSpelling() throws {
        let data = try JSONEncoder().encode(
            SdkCapabilityDescriptor(id: "network.transport.websocket", state: .disabled, reason: "HOST_OPT_IN")
        )
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["state"] as? String, "DISABLED")
        XCTAssertEqual(object["reason"] as? String, "HOST_OPT_IN")
    }
}
