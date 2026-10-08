// Runs when dyld loads the agent into the target app (DYLD_INSERT_LIBRARIES on the simulator).
// Swift has no load-time constructor, so this C shim hands off to the Swift entry point.
extern void am_overlay_agent_start(void);

__attribute__((constructor)) static void am_overlay_agent_load(void) {
    am_overlay_agent_start();
}
