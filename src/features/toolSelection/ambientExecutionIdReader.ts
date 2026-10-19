import type { AmbientExecutionIdReader } from "../../utils/interfaces/AmbientExecutionIdReader";
import { getToolSelectionContext } from "./toolSelectionContext";

export const ambientExecutionIdReader: AmbientExecutionIdReader = {
  getExecutionId: () => getToolSelectionContext()?.execution?.executionId,
};
