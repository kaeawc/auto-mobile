import { ActionableError } from "../../../models/ActionableError";

/** The installed ProtoViewer predates the MCP entry point; a save then keeps the CtrlProxy path. */
export class ProtoViewerEntryPointMissingError extends ActionableError {
  constructor() {
    super("This ProtoViewer build has no MCP entry point. Install a newer ProtoViewer and retry.");
  }
}
