// THROWAWAY (#16349): the 3D script as a bundler would minify it, for the bytes measurement.
import { device3dRuntime } from "./device3dRuntime";
import { DEFAULT_3D_ORBIT, FLAT_ORBIT, POSTURE_HINGE_DEGREES, devicePose, postureAtHinge } from "./devicePose";

device3dRuntime({ pose: devicePose, postureAt: postureAtHinge, flat: FLAT_ORBIT, start: DEFAULT_3D_ORBIT, hinges: POSTURE_HINGE_DEGREES });
