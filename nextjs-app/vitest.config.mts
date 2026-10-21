import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// خط أساس اختبارات بسيط — دوال نقيّة فقط (بلا DOM/شبكة). بيئة node.
export default defineConfig({
  oxc: {
    jsx: "react-jsx",
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
