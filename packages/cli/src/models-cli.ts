#!/usr/bin/env node
import { errorMessage } from '@radar/engine';
import { MODELS_HELP, parseModelsArgs, runModels } from './models.js';

async function main(): Promise<number> {
  const parsed = parseModelsArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    console.log(MODELS_HELP);
    return 0;
  }
  if (parsed.kind === 'error') {
    console.error(parsed.message);
    console.error(MODELS_HELP);
    return 2;
  }
  try {
    console.log(await runModels(parsed.options));
    return 0;
  } catch (err) {
    console.error(`No se pudo obtener el catálogo de OpenRouter: ${errorMessage(err)}`);
    return 2;
  }
}

main().then((code) => {
  process.exitCode = code;
});
