@testable import AutoMobilePrototypeAgentCore
import XCTest

@MainActor
final class PrototypeDeviceStatusOverrideTests: XCTestCase {
    private struct Input: Decodable {
        let timestampMs: Int
        let reading: [String: JSONValue]?
        let mode: DeviceStatusMode?
        let seed: [String: JSONValue]?
    }

    private struct Update: Codable, Equatable {
        let timestampMs: Int
        let values: [String: JSONValue]
    }

    private struct Stream: Decodable {
        let module: String
        let platform: String
        let inputs: [Input]
        let expectedUpdates: [Update]
        let expectedEvents: [Update]
    }

    private struct Refusal: Decodable, Equatable {
        let index: Int
        let path: String
    }

    private struct Rejection: Decodable {
        let name: String
        let module: String
        let platform: String
        let inputs: [Input]
        let expectedError: Refusal
    }

    private struct Rejections: Decodable {
        let cases: [Rejection]
    }

    private var fixtureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-device-status")
    }

    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: fixtureRoot.appendingPathComponent(name)))
    }

    private func apply(_ input: Input, to override: inout DeviceStatusOverride, module: String) throws {
        if let reading = input.reading { override.reading(reading) }
        if let mode = input.mode { override.mode(mode) }
        if let seed = input.seed { try override.seed(module: module, seed) }
    }

    func testSharedSeedFixturesProduceExpectedUpdates() throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: fixtureRoot.path)
            .filter { $0.hasPrefix("override-") && $0.hasSuffix(".json") }.sorted()
        XCTAssertEqual(names, [
            "override-rejections.json", "override-seed-and-reset.json",
            "override-seed-unchanged.json", "override-seed-without-reading.json",
        ])
        for name in names where name != "override-rejections.json" {
            let stream = try fixture(name, as: Stream.self)
            var override = DeviceStatusOverride(platform: stream.platform)
            var updates: [Update] = []
            for input in stream.inputs {
                let before = override.shown
                try apply(input, to: &override, module: stream.module)
                if let shown = override.shown, shown != before {
                    updates.append(Update(timestampMs: input.timestampMs, values: shown))
                }
            }
            XCTAssertEqual(updates, stream.expectedUpdates, name)
        }
    }

    func testSharedFixturesThroughModuleRefreshAndRealDebounce() async throws {
        for name in [
            "override-seed-and-reset.json",
            "override-seed-unchanged.json",
            "override-seed-without-reading.json",
        ] {
            let stream = try fixture(name, as: Stream.self)
            // Suppress the synchronous baseline to also exercise a seed before any reading.
            let source = FakeDeviceStatusSource([:], suppliesBaseline: false)
            let clock = DeviceStatusClock()
            let module = PrototypeDeviceStatusModule(
                name: stream.module,
                capability: stream.module,
                source: source,
                clock: clock
            )
            let events = module.events
            XCTAssertEqual(module.debounceMs, 500)
            var updates: [Update] = []
            var last: [String: JSONValue]?
            for input in stream.inputs {
                clock.advance(to: input.timestampMs)
                if let reading = input.reading { source.report(reading) }
                if let mode = input.mode { module.mode(mode) }
                if let seed = input.seed { try module.seed(seed) }
                // The first reading/seed establishes a baseline even when it is empty.
                if last != nil || input.reading != nil || input.seed != nil {
                    let shown = module.state
                    if shown != last {
                        updates.append(Update(timestampMs: input.timestampMs, values: shown))
                        last = shown
                    }
                }
            }
            clock.advance(to: clock.nowMilliseconds + 1000)
            module.stop()
            var changed: [[String: JSONValue]] = []
            var refreshes = 0
            for await event in events {
                if event == .stateRefresh(stream.module) {
                    refreshes += 1
                } else {
                    XCTAssertEqual(event.event, "\(stream.module).changed")
                    try changed.append(XCTUnwrap(event.data.objectFields))
                }
            }
            XCTAssertEqual(updates, stream.expectedUpdates, name)
            XCTAssertEqual(refreshes, max(0, updates.count - 1), name)
            XCTAssertEqual(changed.count, clock.firedAt.count, "Every settled change must yield exactly one event")
            let actual = zip(clock.firedAt, changed).map { Update(timestampMs: $0.0, values: $0.1) }
            XCTAssertEqual(actual, stream.expectedEvents, name)
        }
    }

    func testEverySharedRejectionHasExpectedIndexAndPath() throws {
        let rejections = try fixture("override-rejections.json", as: Rejections.self)
        for entry in rejections.cases {
            var override = DeviceStatusOverride(platform: entry.platform)
            var refusal: Refusal?
            for (index, input) in entry.inputs.enumerated() {
                let before = override.shown
                do {
                    try apply(input, to: &override, module: entry.module)
                } catch let PrototypeLoadError.invalidSpec(path, _) {
                    refusal = .init(index: index, path: "inputs[\(index)].\(path)")
                    XCTAssertEqual(override.shown, before, entry.name)
                    break
                }
            }
            XCTAssertEqual(refusal, entry.expectedError, entry.name)
        }
    }

    func testModuleFreezesRestoresAndRejectsSeedsAtomically() throws {
        let source = FakeDeviceStatusSource(["volume": .number(40)])
        let module = PrototypeDeviceStatusModule.audio(source: source, clock: DeviceStatusClock())
        XCTAssertEqual(module.state, source.initial)
        XCTAssertThrowsError(try module.seed(["volume": .number(10)]))
        module.mode(.fake)
        source.report(["volume": .number(50)])
        XCTAssertEqual(module.state, source.initial, "fake freezes even before seeding")
        try module.seed(["volume": .number(10)])
        source.report(["volume": .number(60)])
        XCTAssertEqual(module.state, ["volume": .number(10)])
        XCTAssertThrowsError(try module.seed(["volume": .number(20), "ringer": .string("silent")]))
        XCTAssertEqual(module.state, ["volume": .number(10)])
        XCTAssertThrowsError(try module.seed(["route": .string("wired"), "volume": .number(101)]))
        XCTAssertEqual(module.state, ["volume": .number(10)], "a later refusal must discard the entire merge")
        module.mode(.real)
        XCTAssertEqual(module.state, ["volume": .number(60)])
        XCTAssertThrowsError(try module.seed(["volume": .number(10)]))
        module.mode(.fake)
        try module.seed(["volume": .number(5)])
        module.stop()
        XCTAssertEqual(module.state, source.initial, "stop/restart clears overrides")
        module.stop()
    }
}
