#!/usr/bin/env node
/**
 * Executable entry point. All logic lives in ../src.
 */

import { run } from '../src/cli.js';

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    console.error(`\n❌ ${error?.message ?? error}`);
    if (process.env.DEBUG) console.error(error);
    process.exitCode = 1;
  });
