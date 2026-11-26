import { DefaultFileSystem } from "../../../../utils/filesystem/DefaultFileSystem";
import { DefaultHostCommandExecutor } from "../../../../utils/HostCommandExecutor";
import { PlistClient } from "../../../../utils/ios-cmdline-tools/PlistClient";
import { SimulatorIosClearDataBackend } from "../../../../utils/ios-cmdline-tools/SimulatorIosClearDataBackend";
import { getAbortSignal } from "../../../../utils/AbortContext";
import { SimCtlClient } from "../../../../utils/ios-cmdline-tools/SimCtlClient";
import { defaultSimulatorLocationAuthorizationReader } from "../../../../utils/ios-cmdline-tools/SimulatorLocationdClients";
import { SimulatorTccSqliteClient } from "../../../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import {
  DefaultDataContainerWriter,
  DefaultInstallerFileSystem,
  DefaultPrototypeSimctl,
} from "../../ios/iosPrototypeInstallerAdapters";
import { IosPrototypeIconRenderer } from "../../ios/iosPrototypeIconRenderer";
import { PrototypeViewerTemplateProvider } from "../../ios/iosPrototypeViewerTemplateProvider";
import type { DisposableAppPlatformSupport } from "../DisposableAppManager";
import { IosDisposableAppInstaller } from "./IosDisposableAppInstaller";
import { IosDisposableAppStamper } from "./IosDisposableAppStamper";

export function createIosDisposableAppSupport(): DisposableAppPlatformSupport {
  const files = new DefaultInstallerFileSystem();
  const simctl = new SimCtlClient();
  return {
    stamper: new IosDisposableAppStamper({
      template: new PrototypeViewerTemplateProvider(),
      files,
      plist: new PlistClient(),
      icons: new IosPrototypeIconRenderer(),
      commands: new DefaultHostCommandExecutor(),
    }),
    installer: new IosDisposableAppInstaller({
      simctl: new DefaultPrototypeSimctl(simctl),
      commands: simctl,
      data: new DefaultDataContainerWriter(),
      files: new DefaultFileSystem(),
      tcc: new SimulatorTccSqliteClient(),
      location: defaultSimulatorLocationAuthorizationReader(),
      clearStorage: (deviceId, appId) =>
        new SimulatorIosClearDataBackend(deviceId, { simctl }).clearAppData(
          appId,
          getAbortSignal(),
        ),
    }),
  };
}
