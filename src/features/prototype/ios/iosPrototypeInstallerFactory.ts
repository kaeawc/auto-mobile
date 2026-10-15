import { DefaultHostCommandExecutor } from "../../../utils/HostCommandExecutor";
import { PlistClient } from "../../../utils/ios-cmdline-tools/PlistClient";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { IosPrototypeInstaller } from "./iosPrototypeInstaller";
import {
  DefaultDataContainerWriter,
  DefaultInstallerFileSystem,
  DefaultPrototypeSimctl,
} from "./iosPrototypeInstallerAdapters";
import { IosPrototypeIconRenderer } from "./iosPrototypeIconRenderer";
import { PrototypeViewerTemplateProvider } from "./iosPrototypeViewerTemplateProvider";

/** Call only on first saved-action use, never during tool registration. */
export function createDefaultIosPrototypeInstaller(
  env: NodeJS.ProcessEnv = process.env,
): IosPrototypeInstaller {
  const files = new DefaultInstallerFileSystem();
  return new IosPrototypeInstaller({
    template: new PrototypeViewerTemplateProvider({ env }),
    files,
    data: new DefaultDataContainerWriter(),
    simctl: new DefaultPrototypeSimctl(new SimCtlClient()),
    plist: new PlistClient(),
    commands: new DefaultHostCommandExecutor(),
    icons: new IosPrototypeIconRenderer(),
  });
}
