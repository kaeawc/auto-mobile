@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeQueueTests: XCTestCase {
    private struct QueueCase: Decodable {
        struct Step: Decodable {
            let op: [String: JSONValue]
            let expect: Expect
        }

        struct Expect: Decodable, Equatable {
            let currentItemId: String?
            let currentIndex: Int
            let playing: Bool
            let positionMs: Int64
            let shuffle: Bool
            let `repeat`: String
            let rate: Double
            let sleepRemainingMs: Int64?
            let sleepEndOfItem: Bool
            let order: [String]
            let itemChanged: Bool
            let error: String?
        }

        let name: String
        let items: [String]
        let random: [Int]
        let steps: [Step]
    }

    /// Replays a fixed sequence, failing on a value out of range or a draw past its end.
    private final class FakeRandom: PrototypeQueueRandom {
        private let values: [Int]
        private(set) var drawn = 0

        init(_ values: [Int]) {
            self.values = values
        }

        func nextInt(_ bound: Int) -> Int {
            XCTAssertLessThan(drawn, values.count, "random draw past the fixture")
            let value = drawn < values.count ? values[drawn] : 0
            drawn += 1
            XCTAssertTrue((0 ..< bound).contains(value), "random \(value) out of 0..<\(bound)")
            return value
        }
    }

    private struct NoRandom: PrototypeQueueRandom {
        func nextInt(_: Int) -> Int {
            XCTFail("no random draw expected")
            return 0
        }
    }

    private struct HalfRandom: PrototypeQueueRandom {
        func nextInt(_ bound: Int) -> Int {
            bound / 2
        }
    }

    private func cases() throws -> [QueueCase] {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try JSONDecoder().decode([QueueCase].self, from: Data(
            contentsOf: repository.appendingPathComponent("test/fixtures/prototype-media-queue/operations.json")
        ))
    }

    private func op(_ json: [String: JSONValue]) throws -> PrototypeQueue.Op {
        func string(_ key: String) throws -> String {
            guard case let .string(value) = json[key] else { throw FixtureError.field(key) }
            return value
        }
        func number(_ key: String, in object: [String: JSONValue]? = nil) throws -> Double {
            guard case let .number(value) = (object ?? json)[key] else { throw FixtureError.field(key) }
            return value
        }
        switch try string("op") {
        case "play": return .play
        case "pause": return .pause
        case "seek": return try .seek(positionMs: Int64(number("positionMs")))
        case "next": return .next
        case "previous": return .previous
        case "skipTo": return try .skipTo(itemId: string("itemId"))
        case "setShuffle":
            guard case let .bool(shuffle) = json["shuffle"] else { throw FixtureError.field("shuffle") }
            return .setShuffle(shuffle)
        case "setRepeat":
            guard let mode = try PrototypeQueue.Repeat(rawValue: string("repeat")) else {
                throw FixtureError.field("repeat")
            }
            return .setRepeat(mode)
        case "setRate": return try .setRate(number("rate"))
        case "setSleepTimer":
            guard case let .object(timer) = json["timer"] else { throw FixtureError.field("timer") }
            if timer["endOfItem"] == .bool(true) {
                return .setSleepTimer(ms: 0, endOfItem: true)
            }
            return try .setSleepTimer(ms: Int64(number("ms", in: timer)), endOfItem: false)
        case "ended": return .ended
        case "advance": return try .advance(ms: Int64(number("ms")))
        case "sync":
            guard case let .array(items) = json["items"] else { throw FixtureError.field("items") }
            return .sync(items: items.compactMap { if case let .string(id) = $0 { id } else { nil } })
        case let name: throw FixtureError.field("op \(name)")
        }
    }

    private enum FixtureError: Error {
        case field(String)
    }

    private func snapshot(_ result: PrototypeQueue.Result) -> QueueCase.Expect {
        let state = result.state
        return QueueCase.Expect(
            currentItemId: state.currentItemId,
            currentIndex: state.currentIndex,
            playing: state.playing,
            positionMs: state.positionMs,
            shuffle: state.shuffle,
            repeat: state.repeatMode.rawValue,
            rate: state.rate,
            sleepRemainingMs: state.sleepRemainingMs,
            sleepEndOfItem: state.sleep == .endOfItem,
            order: state.order,
            itemChanged: result.itemChanged,
            error: result.error
        )
    }

    func testSharedFixturesReplayToTheSameQueueStateOnEveryPlatform() throws {
        let cases = try cases()
        XCTAssertFalse(cases.isEmpty)
        for testCase in cases {
            let random = FakeRandom(testCase.random)
            var state = PrototypeQueue.start(testCase.items)
            for (index, step) in testCase.steps.enumerated() {
                let result = try PrototypeQueue.apply(state, op(step.op), random: random)
                XCTAssertEqual(snapshot(result), step.expect, "\(testCase.name), step \(index)")
                state = result.state
            }
            XCTAssertEqual(random.drawn, testCase.random.count, "\(testCase.name) consumes every random draw")
        }
    }

    func testASleepTimerDrivenByAFakeClockPausesExactlyWhenItReachesZero() {
        var state = PrototypeQueue.start(["a"])
        state = PrototypeQueue.apply(state, .setSleepTimer(ms: 30000, endOfItem: false), random: NoRandom()).state
        state = PrototypeQueue.apply(state, .play, random: NoRandom()).state
        var pausedAfter: Int?
        for tick in 0 ..< 60 where pausedAfter == nil {
            state = PrototypeQueue.apply(state, .advance(ms: 1000), random: NoRandom()).state
            if !state.playing {
                pausedAfter = tick
            }
        }
        XCTAssertEqual(pausedAfter, 29)
        XCTAssertNil(state.sleep)
    }

    func testShufflingALongQueueIsAPermutationThatKeepsTheCurrentItemFirst() {
        let items = (0 ..< 50).map { "i\($0)" }
        var start = PrototypeQueue.start(items)
        start.currentItemId = "i7"
        let state = PrototypeQueue.apply(start, .setShuffle(true), random: HalfRandom()).state
        XCTAssertEqual(state.order.first, "i7")
        XCTAssertEqual(Set(state.order), Set(items))
        XCTAssertEqual(state.order.count, items.count)
    }
}
