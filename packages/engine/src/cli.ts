#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeRepository } from './engine.js';
import { formatReport } from './report.js';
import { SEVERITY_ORDER, type Severity } from './types.js';

const HELP = `
Uso: radar-deuda <ruta-del-repositorio> [opciones]

Opciones:
  --json <archivo>        Guarda el informe completo en JSON
  --no-cache              Desactiva la caché incremental
  --cache-dir <dir>       Directorio de caché (por defecto, el de datos del usuario)
  --concurrency <n>       Lecturas simultáneas (1–64, por defecto 8)
  --top <n>               Hallazgos a mostrar en la terminal (por defecto 15)
  --fail-on <severidad>   Código de salida 1 si hay hallazgos de esa severidad o mayor
                          (critical | high | medium | low)
  --quiet                 No muestra el progreso
  -h, --help              Muestra esta ayuda

Códigos de salida: 0 correcto · 1 umbral --fail-on superado · 2 error de uso · 130 cancelado
`;

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: 'string' },
        'no-cache': { type: 'boolean', default: false },
        'cache-dir': { type: 'string' },
        concurrency: { type: 'string' },
        top: { type: 'string' },
        'fail-on': { type: 'string' },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(HELP);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length !== 1) {
    console.log(HELP);
    return values.help ? 0 : 2;
  }

  const failOn = values['fail-on'];
  if (failOn !== undefined && !(failOn in SEVERITY_ORDER)) {
    console.error(`Severidad no válida para --fail-on: ${failOn}`);
    return 2;
  }
  const concurrency = values.concurrency !== undefined ? Number(values.concurrency) : undefined;
  const top = values.top !== undefined ? Number(values.top) : 15;

  const controller = new AbortController();
  process.once('SIGINT', () => {
    process.stderr.write('\nCancelando…\n');
    controller.abort();
  });

  const showProgress = !values.quiet && process.stderr.isTTY;
  try {
    const report = await analyzeRepository(positionals[0] as string, {
      config: concurrency !== undefined ? { concurrency } : {},
      ...(values['no-cache'] ? { cacheDir: null } : values['cache-dir'] ? { cacheDir: values['cache-dir'] } : {}),
      signal: controller.signal,
      ...(showProgress
        ? {
            onProgress: (e) => {
              if (e.phase === 'files') process.stderr.write(`\rAnalizando archivos ${e.done}/${e.total}…`);
              if (e.phase === 'cross-file') process.stderr.write('\rAnálisis entre archivos…            ');
              if (e.phase === 'done') process.stderr.write('\r'.padEnd(60) + '\r');
            },
          }
        : {}),
    });
    console.log(formatReport(report, Number.isFinite(top) ? top : 15));
    if (values.json) {
      const out = path.resolve(values.json);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify(report, null, 2), 'utf8');
      console.log(`Informe JSON guardado en ${out}`);
    }
    if (failOn) {
      const limit = SEVERITY_ORDER[failOn as Severity];
      if (report.findings.some((f) => SEVERITY_ORDER[f.severity] >= limit)) return 1;
    }
    return 0;
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
