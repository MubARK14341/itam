export function shouldBlockIndexing(env: Record<string, string | undefined>): boolean {
  return env.APP_ENV === "staging"
    || env.DEPLOYMENT_ENV === "preview"
    || env.VERCEL_ENV === "preview";
}
