/**
 * Example: Custom AadiJS plugin that registers a CLI command (`aadi routes`),
 * a build lifecycle hook, and an AI tool.
 */
import { defineConfig } from "../../packages/core/src/config.ts";
import { definePlugin } from "../../packages/plugins/src/index.ts";

export const bannerPlugin = definePlugin({
  name: "aadi-plugin-banner",
  version: "1.0.0",
  aadi: ">=0.1.0",
  setup(api) {
    api.command("hello-plugin", {
      description: "Custom command added by aadi-plugin-banner",
      run() {
        console.log(`⚡ Hello from aadi-plugin-banner on AadiJS v${api.aadiVersion}!`);
        return 0;
      },
    });
    api.on("buildEnd", (result) => {
      console.log(`[banner-plugin] Build finished in ${result.durationMs.toFixed(1)}ms (${result.outputs.length} outputs)`);
    });
    api.aiTool({
      name: "env-check",
      description: "Check runtime versions",
      async run() {
        return `Bun ${Bun.version} on ${process.platform}/${process.arch}`;
      },
    });
  },
});

export default defineConfig({
  plugins: [bannerPlugin],
});
