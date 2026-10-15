@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeChecksStackScreenTests: XCTestCase {
    func testAllStackScreensBindValidityConditionsAndEmitGuards() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"stack-checks","window":{"placement":{"type":"fullscreen"}},
         "state":{"name":"","detail":""},
         "root":{"type":"stack","id":"nav","start":"home","screens":{
          "home":{"type":"column","children":[
           {"type":"textField","stateKey":"name","checks":[{"required":true,"message":"Required"}]},
           {"type":"button","testTag":"enabled","enabledWhen":{"valid":"name"}},
           {"type":"button","testTag":"submit","onTap":[
            {"type":"emit","name":"submit","requireValid":["name","detail"]}]}]},
          "detail":{"type":"column","children":[
           {"type":"textField","stateKey":"detail","checks":[{"required":true,"message":"Required"}]},
           {"type":"button","enabledWhen":{"valid":"detail"}}]}
         }}}
        """.utf8))
        let homeButton = try XCTUnwrap(spec.root.screens?["home"]?.children?[1])
        let detailButton = try XCTUnwrap(spec.root.screens?["detail"]?.children?[1])
        var session = PrototypeSession()
        session.show(spec)

        XCTAssertEqual(session.validity, ["name": false, "detail": false])
        XCTAssertFalse(session.isEnabled(homeButton))
        XCTAssertFalse(session.isEnabled(detailButton))
        let blocked = try session.simulateTap(identifier: "submit").get()
        XCTAssertEqual(blocked.map(\.kind), ["validation_failed"])
        XCTAssertEqual(blocked.first?.keys, ["name", "detail"])

        let homeChange = session.change(key: "name", value: .string("Ada"))
        XCTAssertEqual(session.validity, ["name": true, "detail": false])
        XCTAssertEqual(homeChange.first?.validity, session.validity)
        XCTAssertTrue(session.isEnabled(homeButton))
        XCTAssertFalse(session.isEnabled(detailButton))
        let stillBlocked = try session.simulateTap(identifier: "submit").get()
        XCTAssertEqual(stillBlocked.map(\.kind), ["validation_failed"])
        XCTAssertEqual(stillBlocked.first?.keys, ["detail"])

        // The detail screen has never been pushed, but its validity must still be tracked.
        let detailChange = session.change(key: "detail", value: .string("Ready"))
        XCTAssertEqual(session.validity, ["name": true, "detail": true])
        XCTAssertEqual(detailChange.first?.validity, session.validity)
        XCTAssertTrue(session.isEnabled(detailButton))
        let submitted = try session.simulateTap(identifier: "submit").get()
        XCTAssertEqual(submitted.map(\.kind), ["emit"])
        XCTAssertEqual(submitted.first?.name, "submit")

        _ = session.change(key: "name", value: .string(""))
        XCTAssertFalse(session.isEnabled(homeButton))
    }
}
