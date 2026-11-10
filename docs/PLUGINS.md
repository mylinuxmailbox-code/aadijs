# AadiJS Plugin System

Plugins extend CLI commands, the Bun bundler pipeline, lifecycle hooks, and Aadi AI tools with strict dependency ordering and semver validation.

## Authoring a Plugin

```ts
import { definePlugin, defineConfig } from "@aadijs/core";

export const myPlugin = definePlugin({
  name: "my-plugin",
  version: "1.0.0",
  aadi: ">=0.1.0",
  requires: [], // Names of plugins that must run before this one
  setup(api) {
    // 1. Register a CLI subcommand (`aadi greet`)
    api.command("greet", {
      description: "Print a custom greeting",
      run(args, { cwd }) {
        console.log("Hello from", cwd, args);
      },
    });

    // 2. Tap into lifecycle hooks: "config" | "buildStart" | "buildEnd" | "devStart" | "testStart" | "diagnose"
    api.on("config", (cfg) => ({ ...cfg, outDir: "build" }));

    // 3. Register a native Bun bundler plugin
    api.bunPlugin({
      name: "virtual-module",
      setup(build) {
        build.onResolve({ filter: /^virtual:env$/ }, () => ({ path: "virtual:env", namespace: "virt" }));
        build.onLoad({ filter: /.*/, namespace: "virt" }, () => ({ contents: "export const ENV = 'prod';", loader: "js" }));
      },
    });

    // 4. Register an Aadi AI tool (`aadi ai my-tool`)
    api.aiTool({
      name: "my-tool",
      description: "Custom inspection tool",
      async run(input) { return `Result for ${input}`; },
    });
  },
});

export default defineConfig({ plugins: [myPlugin] });
```
