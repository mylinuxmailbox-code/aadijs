#!/usr/bin/env bun
import { main } from "../src/index.ts";
import { log } from "../../utils/src/index.ts";

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e: any) {
  log.error(e?.message ?? String(e), e?.hint);
  if (process.env.AADI_DEBUG) console.error(e?.stack);
  process.exitCode = e?.exitCode ?? 1;
}
