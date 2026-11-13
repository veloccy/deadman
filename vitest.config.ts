import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The tests run in workerd with cloudflare.config.ts's bindings. What is watched and where alerts
// go are the tests' own (hosts under .test, which nothing can register), and the rest stand in for
// the secrets. Every outbound call is answered by the test: nothing leaves the machine.
export default defineConfig({
  plugins: [
    cloudflareTest({
      experimental: { newConfig: { configPath: "./cloudflare.config.ts" } },
      miniflare: {
        // the config names the class's Worker, which the test runner stands in for
        durableObjects: { MONITOR: { className: "Monitor", useSQLite: true } },
        bindings: {
          CHANNELS: ["webhook", "email"],
          HEARTBEATS: { cluster: { silentAfterSeconds: 300 } },
          UPTIME: {
            failuresBeforeAlert: 3,
            timeoutSeconds: 10,
            targets: [
              { name: "website", url: "https://www.shop.test/" },
              { name: "api", url: "https://api.shop.test/health", expectBody: "ok" },
              { name: "worker", url: "https://worker.shop.test/health", expectBody: "ok" },
            ],
          },
          ALERT_EMAIL_FROM: "alerts@mail.shop.test",
          WEBHOOK_URL: "https://pager.test/hook/test-hook-token",
          ALERT_EMAIL_TO: "oncall@shop.test",
          PING_SECRET_CLUSTER: "test-ping-secret-for-the-cluster-source",
        },
      },
    }),
  ],
});
