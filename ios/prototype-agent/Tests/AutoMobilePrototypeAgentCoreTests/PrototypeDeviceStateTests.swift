@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class DeviceHandle: PrototypeTimerHandle {
    let due: Int
    let fire: () -> Void
    var cancelled = false
    init(due: Int, fire: @escaping () -> Void) { self.due = due; self.fire = fire }
    func cancel() { cancelled = true }
}

private final class DeviceClock: PrototypeClock {
    var nowMilliseconds = 0
    var handles: [DeviceHandle] = []
    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
        let handle = DeviceHandle(due: nowMilliseconds + afterMilliseconds, fire: fire)
        handles.append(handle)
        return handle
    }

    func elapse(_ milliseconds: Int) {
        nowMilliseconds += milliseconds
        for handle in handles where !handle.cancelled && handle.due <= nowMilliseconds {
            handle.cancel(); handle.fire()
        }
    }
}

final class PrototypeDeviceStateTests: XCTestCase {
    private var prepared: PrototypeSpec!

    override static func setUp() {
        super.setUp()
        do { _ = try makeSpec() }
        catch { XCTFail("Device fixture preparation failed: \(error)") }
    }

    override func setUpWithError() throws { prepared = try Self.makeSpec() }

    private static func makeSpec() throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"device","window":{"placement":{"type":"fullscreen"}},"state":{"n":0},"data":{},
        "requires":{"platform":["device"]},"platform":{"on":{"device.changed":[
        {"type":"increment","key":"n"},
        {"type":"setData","path":"/data/pointer","value":{"event":"/pointer"}}]}},
        "root":{"type":"text","text":"{platform:/device/sizeClass}"}}
        """.utf8))
    }

    private func state(
        _ size: PrototypeDeviceSizeClass = .compact, width: Double = 390.4,
        idiom: PrototypeDeviceIdiom = .phone, pointer: Bool = false
    )
        -> PrototypeDeviceState
    {
        PrototypeDeviceState(
            idiom: idiom,
            horizontalSizeClass: size,
            windowWidth: width,
            windowHeight: 844.6,
            systemVersion: "26.0",
            pointer: pointer
        )
    }

    func testNativeSnapshotAndIdiomMapping() {
        for (idiom, expected) in [
            (PrototypeDeviceIdiom.phone, "phone"),
            (.pad, "tablet"),
            (.mac, "desktop"),
            (.vision, "desktop"),
        ] {
            let device = state(.regular, idiom: idiom).snapshot["device"]?.objectFields
            XCTAssertEqual(
                Set(device?.keys ?? [:].keys),
                ["os", "osVersion", "idiom", "sizeClass", "windowWidth", "windowHeight", "pointer"]
            )
            XCTAssertEqual(device?["idiom"], .string(expected))
            XCTAssertEqual(device?["sizeClass"], .string("regular"))
            XCTAssertEqual(device?["os"], .string("ios"))
            XCTAssertEqual(device?["osVersion"], .string("26.0"))
            XCTAssertEqual(device?["windowWidth"], .number(390))
            XCTAssertEqual(device?["windowHeight"], .number(845))
            XCTAssertEqual(device?["pointer"], .bool(false))
        }
    }

    func testConditionsTextAndMissingForeignKeys() throws {
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"type":"text","text":"{platform:/device/sizeClass}/{platform:/device/widthClass}",
        "visibleWhen":{"platform":"/device/sizeClass","equals":"regular"}}
        """.utf8))
        let compact = PrototypeDataResolver.resolveRoot(raw, data: nil, platform: state().snapshot).objectFields
        let regular = PrototypeDataResolver.resolveRoot(raw, data: nil, platform: state(.regular).snapshot).objectFields
        XCTAssertEqual(compact?["visibleWhen"], .object(["any": .array([])]))
        XCTAssertEqual(regular?["visibleWhen"], .object(["all": .array([])]))
        XCTAssertEqual(regular?["text"], .string("regular/"))
        for operation in ["equals", "notEquals", "gt", "lt"] {
            let condition = JSONValue.object(["platform": .string("/device/widthClass"), operation: .number(1)])
            let root = JSONValue.object(["type": .string("text"), "visibleWhen": condition])
            let resolved = PrototypeDataResolver.resolveRoot(root, data: nil, platform: state().snapshot)
            XCTAssertEqual(
                resolved.objectFields?["visibleWhen"],
                .object([operation == "notEquals" ? "all" : "any": .array([])])
            )
        }
    }

    func testDebouncedDeliveryHandlerAndImmediateState() throws {
        let clock = DeviceClock()
        var session = PrototypeSession()
        session.show(prepared)
        var events: [PrototypeEvent] = []
        var failure: Error?
        let store = PrototypeDeviceStateStore(clock: clock) { name, data in
            do { events += try session.deliverPlatformEvent(name, data: data) }
            catch { failure = error }
        }
        XCTAssertTrue(store.update(state()))
        XCTAssertFalse(store.update(state()))
        clock.elapse(250)
        XCTAssertTrue(events.isEmpty)
        XCTAssertTrue(store.update(state(width: 500)))
        clock.elapse(250)
        XCTAssertTrue(events.isEmpty)
        store.update(state(.regular))
        try session.setPlatformState(store.snapshot)
        XCTAssertEqual(session.spec?.root.text, "regular")
        let revision = session.dataRevision
        clock.elapse(100)
        store.update(state())
        store.update(state(.regular, pointer: true))
        try session.setPlatformState(store.snapshot)
        XCTAssertEqual(session.dataRevision, revision)
        clock.elapse(249)
        XCTAssertTrue(events.isEmpty)
        clock.elapse(1)
        XCTAssertNil(failure)
        XCTAssertEqual(session.state["n"], .number(1))
        XCTAssertEqual(session.data?["pointer"], .bool(true))
        let delivered = events.filter { $0.name == "prototype_platform_event" }
        XCTAssertEqual(delivered.count, 1)
        XCTAssertEqual(
            delivered.first?.payload,
            try .object(["event": .string("device.changed"), "data": XCTUnwrap(store.snapshot["device"])])
        )
        store.update(state(.regular, width: 700, pointer: false))
        clock.elapse(250)
        XCTAssertEqual(events.filter { $0.name == "prototype_platform_event" }.count, 1)
        store.reset()
        store.update(state())
        clock.elapse(250)
        XCTAssertEqual(events.filter { $0.name == "prototype_platform_event" }.count, 1)
    }

    func testSeededShowAndSameGeometryReshowHaveImmediatePlatformState() throws {
        let clock = DeviceClock()
        var deliveries = 0
        let store = PrototypeDeviceStateStore(clock: clock) { _, _ in deliveries += 1 }
        let last = state(.regular)
        store.update(last)
        var session = PrototypeSession()
        for _ in 0 ..< 2 {
            try session.show(prepared.replacingPlatform(store.snapshot))
            XCTAssertEqual(session.spec?.root.text, "regular")
            XCTAssertEqual(session.spec?.platformState, last.snapshot)
            store.reset()
            store.update(last)
            try session.setPlatformState(store.snapshot)
            clock.elapse(250)
            XCTAssertEqual(deliveries, 0)
        }
    }

    func testPlatformRequestTextRemainsLiteral() throws {
        struct Inputs: PrototypeEmitContextInputs {
            func state(_: String) -> JSONValue? { nil }
            func page(_: String) -> Int? { nil }
            func data(_: String) -> JSONValue? { .string("data") }
            func platform(_: String) -> JSONValue? { .string("ios") }
        }
        let action = try JSONDecoder().decode(PrototypeAction.self, from: Data("""
        {"type":"request","url":"https://example.com/{platform:/device/os}/{data:/name}"}
        """.utf8))
        XCTAssertEqual(
            PrototypeRequestResolver.urlText(action, inputs: Inputs()),
            "https://example.com/{platform:/device/os}/data"
        )
    }

    func testPlatformValueBindingsAndEventScope() throws {
        var session = PrototypeSession()
        session.show(prepared)
        try session.setPlatformState(state(.regular, pointer: true).snapshot)
        let actions = try JSONDecoder().decode([PrototypeAction].self, from: Data("""
        [{"type":"setData","path":"/data/os","value":{"platform":"/device/os"}},
         {"type":"setData","path":"/data/missing","value":{"platform":"/device/posture"}},
         {"type":"setData","path":"/data/event","value":{"event":"/pointer"}}]
        """.utf8))
        _ = session.run(actions)
        XCTAssertEqual(session.data?["os"], .string("ios"))
        XCTAssertNil(session.data?["missing"])
        XCTAssertNil(session.data?["event"])
    }

    func testDeviceCapabilitiesDerivedFromUses() throws {
        for root in [
            "{\"type\":\"text\",\"text\":\"{platform:/device/os}\"}",
            "{\"type\":\"text\",\"visibleWhen\":{\"platform\":\"/device/pointer\",\"equals\":true}}",
        ] {
            let capabilities = try PrototypeBundleCapabilities.required(Data("{\"root\":\(root)}".utf8))
            XCTAssertTrue(capabilities.contains("prototype_platform_device_v1"))
            XCTAssertTrue(capabilities.contains("prototype_platform_v1"))
        }
        XCTAssertTrue(AutoMobilePrototypeCapabilities.supported.contains("prototype_platform_device_v1"))
        XCTAssertTrue(AutoMobilePrototypeCapabilities.supported.contains("prototype_platform_v1"))
        XCTAssertFalse(AutoMobilePrototypeCapabilities.supported.contains("prototype_platform_test_v1"))
    }
}
