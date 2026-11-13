import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// What `cf dev` and `cf build` run: the Worker of cloudflare.config.ts.
export default defineConfig({ plugins: [cloudflare()] });
