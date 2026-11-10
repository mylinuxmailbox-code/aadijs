/**
 * @aadijs/plugins — plugin system.
 * Plugins declare a name, optional version-compat range and dependencies, and a `setup(api)` that
 * registers commands, Bun bundler plugins, lifecycle hooks and AI tools.
 */
import type { BunPlugin } from "bun";

export type HookName = "config" | "buildStart" | "buildEnd" | "devStart" | "testStart" | "diagnose";

export interface CommandDef {
  description: string;
  run(args: string[], ctx: { cwd: string }): Promise<number | void> | number | void;
}

export interface AiTool { name: string; description: string; run(input: string): Promise<string> }

export interface PluginAPI {
  aadiVersion: string;
  command(name: string, def: CommandDef): void;
  bunPlugin(p: BunPlugin): void;
  on(hook: HookName, fn: (payload: any) => any): void;
  aiTool(t: AiTool): void;
  options: Record<string, unknown>;
}

export interface AadiPlugin {
  name: string;
  version?: string;
  /** Semver range of AadiJS this plugin supports. */
  aadi?: string;
  /** Names of other plugins that must be loaded first. */
  requires?: string[];
  options?: Record<string, unknown>;
  setup(api: PluginAPI): void | Promise<void>;
}

export const definePlugin = (p: AadiPlugin) => p;

export class PluginHost {
  commands = new Map<string, CommandDef & { plugin: string }>();
  bunPlugins: BunPlugin[] = [];
  aiTools: AiTool[] = [];
  private hooks = new Map<HookName, { plugin: string; fn: (p: any) => any }[]>();
  loaded: string[] = [];

  constructor(public aadiVersion: string) {}

  async load(plugins: AadiPlugin[]) {
    const byName = new Map(plugins.map((p) => [p.name, p]));
    const visiting = new Set<string>();
    const visit = async (p: AadiPlugin) => {
      if (this.loaded.includes(p.name)) return;
      if (visiting.has(p.name)) throw new Error(`Plugin dependency cycle at "${p.name}"`);
      visiting.add(p.name);
      for (const dep of p.requires ?? []) {
        const d = byName.get(dep);
        if (!d) throw new Error(`Plugin "${p.name}" requires "${dep}", which is not configured`);
        await visit(d);
      }
      if (p.aadi && !Bun.semver.satisfies(this.aadiVersion, p.aadi))
        throw new Error(`Plugin "${p.name}" supports AadiJS ${p.aadi}, but this is ${this.aadiVersion}`);
      const api: PluginAPI = {
        aadiVersion: this.aadiVersion,
        options: p.options ?? {},
        command: (name, def) => {
          if (this.commands.has(name)) throw new Error(`Command "${name}" already registered by ${this.commands.get(name)!.plugin}`);
          this.commands.set(name, { ...def, plugin: p.name });
        },
        bunPlugin: (bp) => this.bunPlugins.push(bp),
        on: (h, fn) => { const l = this.hooks.get(h) ?? []; l.push({ plugin: p.name, fn }); this.hooks.set(h, l); },
        aiTool: (t) => this.aiTools.push(t),
      };
      try { await p.setup(api); } catch (e) { throw new Error(`Plugin "${p.name}" failed in setup: ${(e as Error).message}`); }
      visiting.delete(p.name);
      this.loaded.push(p.name);
    };
    for (const p of plugins) await visit(p);
  }

  /** Run hooks sequentially; a hook may return a replacement payload (waterfall). Errors are attributed to the plugin. */
  async emit<T>(hook: HookName, payload: T): Promise<T> {
    let cur = payload;
    for (const { plugin, fn } of this.hooks.get(hook) ?? []) {
      try { const r = await fn(cur); if (r !== undefined) cur = r; }
      catch (e) { throw new Error(`Plugin "${plugin}" failed in "${hook}" hook: ${(e as Error).message}`); }
    }
    return cur;
  }
}
