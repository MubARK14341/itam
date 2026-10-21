export function shouldShowManagerDemo(env: Record<string, string | undefined>): boolean {
  return env.APP_ENV === "staging" || env.MANAGER_DEMO === "true";
}
