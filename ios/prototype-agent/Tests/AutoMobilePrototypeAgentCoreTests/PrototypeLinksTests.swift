@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeLinksTests: XCTestCase {
    private func resolved(_ url: String, _ mode: String?) -> [String: JSONValue] {
        var args: [String: JSONValue] = ["url": .string(url)]
        if let mode { args["mode"] = .string(mode) }
        return args
    }

    func testResolvedInAppWithNonWebSchemeIsRefusedAtMode() {
        for url in ["tel:+15551234567", "mailto:a@b.test", "sms:+1555", "geo:1,2", "maps://?q=a"] {
            XCTAssertEqual(
                PrototypeLinks.argumentsError(resolved(url, "inApp"), path: "args", resolved: true),
                .init(path: "args.mode", message: PrototypeLinks.inAppMessage)
            )
        }
    }

    func testResolvedWebUrlsAndOtherModesPass() {
        XCTAssertNil(PrototypeLinks.argumentsError(resolved("https://a.test", "inApp"), path: "args", resolved: true))
        XCTAssertNil(PrototypeLinks.argumentsError(resolved("http://a.test", "inApp"), path: "args", resolved: true))
        for mode in ["external", "auto", nil] {
            XCTAssertNil(PrototypeLinks.argumentsError(resolved("tel:+1555", mode), path: "args", resolved: true))
        }
    }

    func testLiteralSpecArgumentsAreCheckedAndBoundOnesLeftToTheRuntime() {
        XCTAssertEqual(
            PrototypeLinks.argumentsError(
                ["url": .object(["value": .string("tel:+1555")]), "mode": .object(["value": .string("inApp")])],
                path: "root.args"
            ),
            .init(path: "root.args.mode.value", message: PrototypeLinks.inAppMessage)
        )
        XCTAssertNil(PrototypeLinks.argumentsError(
            ["url": .object(["state": .string("url")]), "mode": .object(["value": .string("inApp")])],
            path: "root.args"
        ))
    }
}
