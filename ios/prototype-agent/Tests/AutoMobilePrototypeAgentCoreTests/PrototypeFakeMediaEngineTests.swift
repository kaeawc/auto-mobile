@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeFakeMediaEngineTests: XCTestCase {
    private struct SimCase: Decodable {
        struct Step: Decodable {
            let op: String
            let player: String?
            let durationMs: Int?
            let loop: Bool?
            let positionMs: Int?
            let ms: Int?
            let event: String?
            let data: [String: JSONValue]?
            let error: String?
        }

        struct Event: Decodable {
            let name: String
            let payload: [String: JSONValue]
        }

        struct State: Decodable {
            let playing: Bool
            let positionMs: Int
            let durationMs: Int
            let buffering: Bool
            let status: String
            let error: String?
        }

        struct Expected: Decodable {
            struct Media: Decodable {
                let players: [String: State]
            }

            let events: [Event]
            let state: Media
        }

        let name: String
        let steps: [Step]
        let expected: Expected
    }

    private func cases() throws -> [SimCase] {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try JSONDecoder().decode([SimCase].self, from: Data(
            contentsOf: repository.appendingPathComponent("test/fixtures/prototype-media-sim/scripts.json")
        ))
    }

    private func run(_ engine: PrototypeFakeMediaEngine, _ step: SimCase.Step) -> PrototypeFakeMediaEngine.Failure? {
        let player = step.player ?? ""
        switch step.op {
        case "load":
            engine.load(player, durationMs: step.durationMs ?? 0, loop: step.loop ?? false)
            return nil
        case "play": return engine.play(player)
        case "pause": return engine.pause(player)
        case "seek": return engine.seek(player, positionMs: step.positionMs ?? 0)
        case "advance":
            engine.advance(step.ms ?? 0)
            return nil
        case "release": return engine.release(player)
        default:
            let data = step.data ?? [:]
            return engine.simulate(PrototypeFakeMediaEngine.SimRequest(
                event: step.event ?? "",
                player: data["player"]?.stringValue ?? "",
                status: data["status"]?.stringValue,
                code: data["code"]?.stringValue,
                advanceMs: data["advanceMs"]?.intValue
            ))
        }
    }

    func testSharedScriptsProduceTheSameEventsAndPlatformMediaStateOnEveryPlatform() throws {
        let cases = try cases()
        XCTAssertFalse(cases.isEmpty)
        for testCase in cases {
            let engine = PrototypeFakeMediaEngine()
            for step in testCase.steps {
                XCTAssertEqual(run(engine, step)?.rawValue, step.error, "\(testCase.name): \(step.op)")
            }
            XCTAssertEqual(
                engine.events,
                testCase.expected.events.map { PrototypeFakeMediaEngine.Event(name: $0.name, payload: $0.payload) },
                testCase.name
            )
            let state = Dictionary(uniqueKeysWithValues: engine.snapshot().map { ($0.id, $0.state) })
            let expected = testCase.expected.state.players.mapValues {
                PrototypeFakeMediaEngine.State(
                    playing: $0.playing, positionMs: $0.positionMs, durationMs: $0.durationMs,
                    buffering: $0.buffering, status: $0.status, error: $0.error
                )
            }
            XCTAssertEqual(state, expected, testCase.name)
        }
    }

    func testErrorCodesComeFromTheContract() {
        XCTAssertEqual(
            PrototypeFakeMediaEngine.errorCodes,
            ["source_not_found", "decode", "network", "unsupported_format", "blocked_egress"]
        )
    }

    func testReleaseDropsThePlayerAndLaterCallsRefuseIt() {
        let engine = PrototypeFakeMediaEngine()
        engine.load("a", durationMs: 1000)
        engine.load("b", durationMs: 2000)
        XCTAssertNil(engine.release("a"))
        XCTAssertEqual(engine.snapshot().map(\.id), ["b"])
        XCTAssertEqual(engine.play("a"), .unknownPlayer)
    }
}
