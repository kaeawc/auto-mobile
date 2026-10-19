import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import type { AmbientExecutionIdReader } from "../utils/interfaces/AmbientExecutionIdReader";

export const ambientExecutionIdReader: AmbientExecutionIdReader = {
  getExecutionId: () => getToolSelectionContext()?.execution?.executionId,
};

export {
  type DeviceExecutionBinding,
  ambientDeviceExecutionBinding,
} from "../utils/deviceExecutionBinding";
