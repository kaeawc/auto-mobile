import AutoMobileSDK
import CarPlay
import UIKit

@main
final class FixtureAppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]?
    )
        -> Bool
    {
        AutoMobileSDK.shared.initialize(bundleId: "dev.jasonpearson.automobile.CarPlayFixture")
        return true
    }
}

final class PhoneSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo _: UISceneSession, options _: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        let label = UILabel()
        label.text = "CarPlay fixture"
        label.textAlignment = .center
        controller.view = label
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
    }
}

final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    func templateApplicationScene(
        _: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        AutoMobileSDK.shared.registerCarPlay(interfaceController: interfaceController)
        let sections = ["Nearby", "Favorites"].enumerated().map { index, header in
            let item = CPListItem(text: index == 0 ? "North charger" : "Home charger", detailText: "Available")
            item.handler = { [weak interfaceController] _, completion in
                let detail = CPListTemplate(
                    title: "Charger details",
                    sections: [CPListSection(items: [CPListItem(text: "Ready to charge", detailText: "Two ports")])]
                )
                interfaceController?.pushTemplate(detail, animated: false, completion: nil)
                completion()
            }
            return CPListSection(items: [item], header: header, sectionIndexTitle: nil)
        }
        let list = CPListTemplate(title: "Chargers", sections: sections)
        list.tabTitle = "Chargers"
        let buttons = ["Start", "Status"].map { title in
            CPGridButton(titleVariants: [title], image: UIImage()) { _ in }
        }
        let grid = CPGridTemplate(title: "Charging", gridButtons: buttons)
        grid.tabTitle = "Charging"
        interfaceController.setRootTemplate(CPTabBarTemplate(templates: [list, grid]), animated: false, completion: nil)
    }

    func templateApplicationScene(
        _: CPTemplateApplicationScene,
        didDisconnectInterfaceController _: CPInterfaceController
    ) {
        AutoMobileSDK.shared.unregisterCarPlay()
    }
}
