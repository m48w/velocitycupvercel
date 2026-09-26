import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "app",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                SUPERADMIN_PASSWORD: "superadmin1234",
                SUBADMIN_PASSWORD: "subadmin1234",
                SESSION_SECRET: "test-session-secret",
              },
            },
          }),
        ],
        test: { name: "worker", include: ["worker/**/*.test.ts"] },
      },
    ],
  },
});
