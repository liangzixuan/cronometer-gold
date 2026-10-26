const rootFiles = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "turbo.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "scripts/appwrite/pack-site.mjs",
  "scripts/appwrite/start-site.cjs",
  "scripts/appwrite/web-source-inputs.mjs",
]);

// This is the complete build input boundary, not a provider scan exception.
export function webSourcePath(path) {
  if (
    typeof path !== "string" ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path.includes("\\") ||
    /(?:^|\/)(?:__tests__|tests?|__fixtures__|fixtures?|e2e)(?:\/|$)/u.test(path) ||
    /\.(?:test|spec)\.[^/]+$/u.test(path)
  )
    return false;
  return (
    rootFiles.has(path) ||
    ["apps/web/", "packages/contracts/", "patches/"].some((prefix) => path.startsWith(prefix))
  );
}
