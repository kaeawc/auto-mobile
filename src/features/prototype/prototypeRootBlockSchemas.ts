import { prototypeAuthSchema } from "./prototypeAuthSchema";
import { prototypeLocationBlockSchema } from "./prototypeLocationBlockSchema";
import { prototypeNotificationsSchema } from "./prototypeNotificationsSchema";
import { prototypeCommerceSchema } from "./prototypeCommerceSchema";

/** The optional platform root blocks a spec may declare beside `requires` (#14303, #14314, #14324, #14280). */
export function prototypeRootBlockFields() {
  return {
    auth: prototypeAuthSchema().optional(),
    commerce: prototypeCommerceSchema().optional(),
    location: prototypeLocationBlockSchema().optional(),
    notifications: prototypeNotificationsSchema().optional(),
  };
}
