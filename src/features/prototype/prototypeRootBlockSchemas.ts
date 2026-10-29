import { prototypeAuthSchema } from "./prototypeAuthSchema";
import { prototypeLocationBlockSchema } from "./prototypeLocationBlockSchema";
import { prototypeNotificationsSchema } from "./prototypeNotificationsSchema";

/** The optional platform root blocks a spec may declare beside `requires` (#14303, #14324, #14280). */
export function prototypeRootBlockFields() {
  return {
    auth: prototypeAuthSchema().optional(),
    location: prototypeLocationBlockSchema().optional(),
    notifications: prototypeNotificationsSchema().optional(),
  };
}
