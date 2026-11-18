#if canImport(UIKit)
    import ObjectiveC
    import UIKit

    /// UIKit delegates own URL delivery; preserve their existing implementations and return values.
    /// No scheme is inferred from spec content. Web association support is intentionally not registered here.
    @MainActor
    enum PrototypeURLDelivery {
        static let inbox = PrototypeInboundLinkInbox()
        private static var installed = false
        private static var methods: Set<String> = []

        static var registeredSchemes: [String] {
            PrototypeInboundLinkSchemes
                .registered(
                    (Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? [])
                        .flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
                )
        }

        static var capabilities: [String] {
            PrototypeInboundLinkSchemes.capabilities(installed: installed, schemes: registeredSchemes)
        }

        static func receive(_ url: URL) {
            // Document imports remain owned by the host. ProtoViewer separates its MCP URLs at its callback.
            guard PrototypeInboundLinkSchemes.accepts(url, schemes: registeredSchemes) else { return }
            inbox.receive(url.absoluteString)
        }

        static func install() {
            guard !installed else { return }
            installed = true
            exchange(UIApplication.self, "setDelegate:", #selector(UIApplication.prototypeSetDelegate(_:)))
            exchange(UIScene.self, "setDelegate:", #selector(UIScene.prototypeSetDelegate(_:)))
        }

        static func hookExistingDelegates() {
            install()
            if let delegate = UIApplication.shared.delegate { hookApplication(delegate) }
            for scene in UIApplication.shared.connectedScenes {
                if let delegate = scene.delegate { hookScene(delegate) }
            }
        }

        private static func exchange(_ cls: AnyClass, _ original: String, _ replacement: Selector) {
            guard let first = class_getInstanceMethod(cls, NSSelectorFromString(original)),
                  let second = class_getInstanceMethod(cls, replacement) else { return }
            method_exchangeImplementations(first, second)
        }

        /// Add on the concrete class rather than modifying an inherited method on a host superclass.
        private static func replace(
            _ delegate: AnyObject, _ selector: Selector, types: String, block: (IMP?) -> AnyObject
        ) {
            guard let cls: AnyClass = object_getClass(delegate) else { return }
            let key = NSStringFromClass(cls) + ":" + NSStringFromSelector(selector)
            guard methods.insert(key).inserted else { return }
            let method = class_getInstanceMethod(cls, selector)
            let implementation = imp_implementationWithBlock(block(method.map(method_getImplementation)))
            let encoding = method.flatMap(method_getTypeEncoding)
            types.withCString { fallback in
                _ = class_replaceMethod(cls, selector, implementation, encoding ?? fallback)
            }
        }

        static func hookApplication(_ delegate: any UIApplicationDelegate) {
            let open = #selector(UIApplicationDelegate.application(_:open:options:))
            replace(delegate, open, types: "B@:@@@") { original in
                typealias Callback = @convention(block) (AnyObject, UIApplication, NSURL, NSDictionary) -> Bool
                let callback: Callback = { object, app, url, options in
                    MainActor.assumeIsolated {
                        receive(url as URL)
                        guard let original else { return true }
                        typealias Call = @convention(c) (AnyObject, Selector, UIApplication, NSURL, NSDictionary)
                            -> Bool
                        return unsafeBitCast(original, to: Call.self)(object, open, app, url, options)
                    }
                }
                return callback as AnyObject
            }
            let launch = #selector(UIApplicationDelegate.application(_:didFinishLaunchingWithOptions:))
            replace(delegate, launch, types: "B@:@@") { original in
                typealias Callback = @convention(block) (AnyObject, UIApplication, NSDictionary?) -> Bool
                let callback: Callback = { object, app, options in
                    MainActor.assumeIsolated {
                        if let url = options?[UIApplication.LaunchOptionsKey.url] as? URL { receive(url) }
                        guard let original else { return true }
                        typealias Call = @convention(c) (AnyObject, Selector, UIApplication, NSDictionary?) -> Bool
                        return unsafeBitCast(original, to: Call.self)(object, launch, app, options)
                    }
                }
                return callback as AnyObject
            }
        }

        static func hookScene(_ delegate: any UISceneDelegate) {
            let open = #selector(UISceneDelegate.scene(_:openURLContexts:))
            replace(delegate, open, types: "v@:@@") { original in
                let callback: @convention(block) (AnyObject, UIScene, NSSet) -> Void = { object, scene, contexts in
                    MainActor.assumeIsolated {
                        for case let context as UIOpenURLContext in contexts {
                            receive(context.url)
                        }
                        if let original {
                            typealias Call = @convention(c) (AnyObject, Selector, UIScene, NSSet) -> Void
                            unsafeBitCast(original, to: Call.self)(object, open, scene, contexts)
                        }
                    }
                }
                return callback as AnyObject
            }
            let connect = #selector(UISceneDelegate.scene(_:willConnectTo:options:))
            replace(delegate, connect, types: "v@:@@@") { original in
                typealias Callback = @convention(block) (AnyObject, UIScene, UISceneSession, UIScene.ConnectionOptions)
                    -> Void
                let callback: Callback = { object, scene, session, options in
                    MainActor.assumeIsolated {
                        for context in options.urlContexts {
                            receive(context.url)
                        }
                        if let original {
                            typealias Call = @convention(c) (
                                AnyObject, Selector, UIScene, UISceneSession, UIScene.ConnectionOptions
                            ) -> Void
                            unsafeBitCast(original, to: Call.self)(object, connect, scene, session, options)
                        }
                    }
                }
                return callback as AnyObject
            }
        }
    }

    extension UIApplication {
        @objc
        fileprivate func prototypeSetDelegate(_ delegate: (any UIApplicationDelegate)?) {
            if let delegate { PrototypeURLDelivery.hookApplication(delegate) }
            prototypeSetDelegate(delegate)
        }
    }

    extension UIScene {
        @objc
        fileprivate func prototypeSetDelegate(_ delegate: (any UISceneDelegate)?) {
            if let delegate { PrototypeURLDelivery.hookScene(delegate) }
            prototypeSetDelegate(delegate)
        }
    }

    extension PrototypeModel: PrototypeInboundLinkTarget {
        var isReadyForInboundLinks: Bool { showRevision > 0 }
        func receiveInboundLink(_ url: String) {
            openLink(url, registeredSchemes: PrototypeURLDelivery.registeredSchemes)
        }
    }
#endif
