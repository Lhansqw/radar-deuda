#!/usr/bin/env node
import { FULL_HELP as HELP, parseCli, run, type Io } from './app.js';

async function main(): Promise<number> {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed.kind === 'help') {
    console.log(HELP);
    return 0;
  }
  if (parsed.kind === 'error') {
    console.error(parsed.message);
    console.error(HELP);
    return 2;
  }
  const o = parsed.options;
  const io: Io = {
    info: (m) => {
      if (!o.quiet) console.error(m);
    },
    warn: (m) => {
      if (!o.quiet) console.error(`Aviso: ${m}`);
    },
  };
  const controller = new AbortController();
  process.once('SIGINT', () => {
    process.stderr.write('\nCancelando…\n');
    controller.abort();
  });
  try {
    return await run(o, io, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      console.error('Análisis cancelado.');
      return 130;
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

main().then((code) => {
  process.exitCode = code;
});
