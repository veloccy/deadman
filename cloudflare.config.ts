import { bindings, defineConfig, exports, triggers } from "cf/config";

// A dead-man switch and outside-in uptime checks, in one Worker. See README.md.
//
// This file is an example to edit: the heartbeat sources, the uptime targets and the email sender
// below are placeholders. The Worker refuses to run while a URL or an address still points at
// example.com, and until every secret at the bottom is set.
//
// A deploy from the Deploy to Cloudflare button runs on Workers Builds, which names the Worker in
// its setup form and passes that name here.
const name = process.env.WRANGLER_CI_OVERRIDE_NAME ?? "deadman";

export default defineConfig({
  // Set your own here: `accountId: "<your Cloudflare account>"`, and, to serve the Worker from
  // your own hostname instead of workers.dev, `domains: ["<your hostname>"]` below.
  worker: {
    name,
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-09-01",
    // Fetch as the public internet does: an uptime check must see what a person sees, and a fetch
    // of another Worker's hostname in the same account must not short-cut to that Worker.
    compatibilityFlags: ["global_fetch_strictly_public"],
    observability: { enabled: true },
    triggers: [triggers.scheduled({ schedule: "* * * * *" })],
    exports: { Monitor: exports.durableObject({ storage: "sqlite" }) },
    env: {
      MONITOR: bindings.durableObject({ worker: name, exportName: "Monitor" }),

      // Where alerts go: "webhook", "email" or both. At least one. Every channel listed here must
      // be fully set up below, and a channel not listed is never used.
      CHANNELS: bindings.json(["webhook", "email"]),
      // Each delivery (one webhook alert, one email) gives up after this many seconds, 1 to 15.
      // The deliveries of a run go out side by side.
      DELIVERY_TIMEOUT_SECONDS: bindings.json(10),

      // The email channel: Cloudflare Email Service. ALERT_EMAIL_FROM's domain must be onboarded
      // to Email Sending on your account. Without the email channel, delete these two lines and
      // ALERT_EMAIL_TO at the bottom.
      EMAIL: bindings.sendEmail(),
      ALERT_EMAIL_FROM: bindings.text("alerts@example.com"),

      // Heartbeats: who must keep pinging. Each source pings POST /ping/<source> with
      // `Authorization: Bearer <PING_SECRET_<SOURCE>>` (the source in upper case, - as _), and each
      // needs that secret declared at the bottom. Silent longer than silentAfterSeconds: one
      // alert, then one more on the first ping back. Names are lower-case letters, digits and -.
      HEARTBEATS: bindings.json({ cluster: { silentAfterSeconds: 300 } }),

      // Uptime: what must keep answering. Checked every minute. Down after failuresBeforeAlert
      // failures in a row (no answer within timeoutSeconds, 1 to 20, or a final status outside
      // 200-299); up again on the first success. A target with expectBody is a health route:
      // redirects are not followed and the body must be exactly that, so a login page or a parked
      // domain answering 200 is not "up". URLs must be https.
      UPTIME: bindings.json({
        failuresBeforeAlert: 3,
        timeoutSeconds: 10,
        targets: [
          { name: "website", url: "https://www.example.com/" },
          { name: "api", url: "https://api.example.com/health", expectBody: "ok" },
        ],
      }),

      // Secrets (`cf workers secrets update`, or .dev.vars locally).
      // The webhook channel: each alert is POSTed here as JSON. A secret because such URLs carry
      // a token. Delete it if you do not use the webhook channel.
      WEBHOOK_URL: bindings.secret(),
      ALERT_EMAIL_TO: bindings.secret(), // the email channel: where alert emails go
      // One per source in HEARTBEATS, at least 32 characters (`openssl rand -hex 32`).
      PING_SECRET_CLUSTER: bindings.secret(),
    },
  },
});
