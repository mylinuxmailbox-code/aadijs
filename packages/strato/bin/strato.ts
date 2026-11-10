#!/usr/bin/env bun
import { stratoMain } from "../src/cli.ts";
import { log } from "../../utils/src/index.ts";

try {
  process.exitCode = await stratoMain(process.argv.slice(2));
} catch (e: any) {
  log.error(e?.message ?? String(e), e?.hint);
  if (process.env.STRATO_DEBUG) console.error(e?.stack);
  process.exitCode = e?.exitCode ?? 1;
}
