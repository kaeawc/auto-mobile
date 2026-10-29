@testable import AutoMobileSdkWire
import Foundation
import XCTest

final class SdkRouteAndErrorTests: XCTestCase {
    func testRoutesAreUniqueAbsolutePathsWithAMethodEach() {
        XCTAssertEqual(SdkRoute.allCases.count, 19)
        XCTAssertEqual(Set(SdkRoute.allCases.map(\.path)).count, SdkRoute.allCases.count)
        for route in SdkRoute.allCases {
            XCTAssertTrue(route.path.hasPrefix("/"), route.path)
            XCTAssertEqual(route.path, route.rawValue)
            XCTAssertTrue(["GET", "POST"].contains(route.method), route.path)
        }
    }

    func testOnlyTheReadRoutesAreGets() {
        XCTAssertEqual(
            Set(SdkRoute.allCases.filter { $0.method == "GET" }),
            [.cachedHierarchy, .freshHierarchy, .health]
        )
    }

    func testThePathsTheRunnerDialsAreTheOnesTheSdkServes() {
        XCTAssertEqual(SdkRoute.freshHierarchy.path, "/hierarchy/fresh")
        XCTAssertEqual(SdkRoute.networkFaultRules.path, "/network/fault-rules")
        XCTAssertEqual(SdkRoute.magicTap.path, "/accessibility/magic-tap")
        XCTAssertEqual(SdkRoute.dbTableStructure.path, "/db/table-structure")
        XCTAssertEqual(SdkRoute.observationSnapshot.path, "/observation/snapshot")
        XCTAssertEqual(SdkRoute.observationAction.path, "/observation/action")
        XCTAssertEqual(SdkRoute(rawValue: "/preferences"), .preferences)
        XCTAssertNil(SdkRoute(rawValue: "/nope"))
    }

    func testTheDatabaseErrorBodyCarriesAnOptionalDiagnostic() throws {
        let plain = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: Data(#"{"error":"locked"}"#.utf8))
        XCTAssertEqual(plain, SdkDatabaseErrorPayload(error: "locked"))
        XCTAssertNil(plain.diagnostic)
        let withDiagnostic = SdkDatabaseErrorPayload(
            error: "read only", diagnostic: StorageDiagnostic(code: "READ_ONLY", message: "database opened read-only")
        )
        let decoded = try JSONDecoder().decode(
            SdkDatabaseErrorPayload.self, from: JSONEncoder().encode(withDiagnostic)
        )
        XCTAssertEqual(decoded, withDiagnostic)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(withDiagnostic)) as? [String: Any]
        )
        XCTAssertEqual((object["diagnostic"] as? [String: String])?["code"], "READ_ONLY")
    }
}
