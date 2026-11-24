import WebKit

@MainActor
struct ViewerWebDataWiper: PrototypeWebDataWiper {
    func wipe(_ identifier: UUID) async {
        if #available(iOS 17, *) {
            let store = WKWebsiteDataStore(forIdentifier: identifier)
            await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        }
    }
}
