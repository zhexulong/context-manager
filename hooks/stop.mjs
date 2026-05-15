#!/usr/bin/env node

import process from "node:process";

import { isMainModule } from "../scripts/lib/utils.mjs";

export { main, mainFromCli } from "./session_end.mjs";

if (isMainModule(import.meta.url)) {
  const module = await import("./session_end.mjs");
  process.exit(await module.main());
}
