/** Raw name-based lookup for injectable adapters whose interfaces accept runtime names. */
export function readProcessEnvByName(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[name];
}
