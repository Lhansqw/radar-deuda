#!/usr/bin/env node
import { errorMessage } from '@radar/engine';
import { CACHE_HELP, parseCacheArgs, runCache } from './cache.js';

async function main(): Promise<number> {
  const cmd = parseCacheArgs(process.argv.slice(2));
  if (cmd.kind === 'help') {
    console.log(CACHE_HELP);
    return 0;
  }
  if (cmd.kind === 'error') {
    console.error(cmd.message);
    console.error(CACHE_HELP);
    return 2;
  }
  try {
    console.log(await runCache(cmd));
    return 0;
  } catch (err) {
    console.error(errorMessage(err));
    return 2;
  }
}

main().then((code) => {
  process.exitCode = code;
});
