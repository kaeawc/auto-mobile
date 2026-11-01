@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypePlatformGestureTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        _ = PrototypePlatformValidator.modules
        _ = try? PrototypeSpecFixtures.invalid("gesture-onAppear").decode()
    }

    func testRefusedGestureFixturesMatchHostPathsAndMessages() throws {
        let directory = PrototypeSpecFixtures.directory.appendingPathComponent("invalid")
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasPrefix("gesture-") && $0.hasSuffix(".json") }.sorted()
        XCTAssertEqual(names.count, 12)
        for name in names {
            let fixture = try PrototypeSpecFixtures.invalid(String(name.dropLast(5)))
            XCTAssertThrowsError(try fixture.decode(), name) { error in
                guard case let DecodingError.dataCorrupted(context) = error else {
                    return XCTFail("\(name): \(error)")
                }
                XCTAssertEqual(
                    context.debugDescription,
                    "\(fixture.expectedPath): \(fixture.expectedMessage ?? "")", name
                )
            }
        }
    }

    func testAllowedGestureFixturesAndExistingGesturesLoad() throws {
        let directory = PrototypeSpecFixtures.directory.appendingPathComponent("valid")
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasPrefix("gesture-") && $0.hasSuffix(".json") }.sorted()
        XCTAssertEqual(names.count, 15)
        for name in names + ["gestures.json", "gestures-repeat.json"] {
            let data = try Data(contentsOf: directory.appendingPathComponent(name))
            XCTAssertNoThrow(try JSONDecoder().decode(PrototypeSpec.self, from: data), name)
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data), name)
        }
    }

    func testLoadedCallsKeepContractGestureFlags() {
        let flagged = PrototypePlatformValidator.modules.flatMap { name, module in
            module.calls.compactMap { call, definition in definition.userGesture ? "\(name).\(call)" : nil }
        }.sorted()
        XCTAssertEqual(
            flagged,
            ["notifications.post", "notifications.schedule", "notifications.setBadge", "share.open"]
        )
    }

    // These shapes are outside the structural contract. As in TS, test the platform policy seam
    // directly so structural errors cannot hide a regression in gesture provenance.
    func testNestedOwnerCannotRegainGestureAfterOnAppear() throws {
        try refusedRoot(
            #"{"type":"text","text":"Share","onAppear":[{"onTap":[CALL]}]}"#,
            path: "root.onAppear[0].onTap[0]"
        )
    }

    func testNestedOwnerCannotRegainGestureAfterTimer() throws {
        try refusedRoot(
            #"{"type":"button","label":"Share","onTap":[{"type":"startTimer","id":"tick","afterMs":100,"actions":[{"onTap":[CALL]}]}]}"#,
            path: "root.onTap[0].actions[0].onTap[0]"
        )
    }

    func testTopAppBarOwnerOnAppearIsNotAGesture() throws {
        try refusedRoot(
            #"{"type":"topAppBar","title":"Share","actions":[{"icon":"share","label":"Share","onAppear":[CALL]}]}"#,
            path: "root.actions[0].onAppear[0]"
        )
    }

    func testNodeRootCallHasNoGesture() throws {
        try refusedRoot("CALL", path: "root")
    }

    private func refusedRoot(_ json: String, path: String) throws {
        let call = #"{"type":"platform","call":"share.open","args":{"text":{"value":"Hi"}}}"#
        let root = try JSONDecoder().decode(
            JSONValue.self, from: Data(json.replacingOccurrences(of: "CALL", with: call).utf8)
        )
        XCTAssertThrowsError(try PrototypePlatformValidator.validate(
            requires: .object(["platform": .array([.string("share")])]), handlers: nil, root: root, state: [:]
        )) { error in
            guard case let DecodingError.dataCorrupted(context) = error else {
                return XCTFail("\(error)")
            }
            XCTAssertEqual(
                context.debugDescription,
                "\(path): Side-effecting platform call share.open needs a user gesture: move it into onTap, onLongPress, onDoubleTap or onSubmit"
            )
        }
    }
}
