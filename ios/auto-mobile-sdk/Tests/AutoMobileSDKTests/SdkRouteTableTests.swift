@testable import AutoMobileSDK
import XCTest

final class SdkRouteTableTests: XCTestCase {
    func testEveryRouteHasExactlyOneEntryWithMatchingMethod() {
        let routes = SdkRouteTable.entries.map(\.route)
        XCTAssertEqual(routes.count, SdkRouteTable.Route.allCases.count)
        XCTAssertEqual(Set(routes), Set(SdkRouteTable.Route.allCases))
        for route in routes {
            XCTAssertEqual(
                SdkRouteTable.route(forRequestLine: "\(route.method) \(route.rawValue) HTTP/1.1"),
                .matched(route)
            )
        }
    }

    func testStorageRoutesKeepTheirBodyReadingPolicy() {
        let storageRoutes = SdkRouteTable.entries.compactMap { entry -> SdkRouteTable.Route? in
            if case .storageQueue = entry.handler { return entry.route }
            return nil
        }
        let bodyStorageRoutes = SdkRouteTable.entries.compactMap { entry -> SdkRouteTable.Route? in
            if case .bodyThenStorage = entry.handler { return entry.route }
            return nil
        }
        XCTAssertEqual(Set(storageRoutes), [.dbList, .dbCapabilities])
        XCTAssertEqual(
            Set(bodyStorageRoutes),
            [.dbExecute, .dbTables, .dbTableData, .dbTableStructure, .dbCoreDataQuery, .preferences, .keychainDelete]
        )
    }
}
