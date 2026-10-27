/**
 * Prueba de extremo a extremo de la aplicación compilada: npm run e2e:desktop.
 *
 * Abre Electron con datos y caché temporales, añade una copia del repositorio
 * de ejemplo, la analiza, recorre las vistas, configura OpenRouter, guarda una
 * clave y pide una explicación a la IA. OpenRouter se simula dentro del
 * proceso principal: la prueba no sale a la red ni necesita una clave real.
 * Deja capturas en apps/desktop/e2e/capturas.
 *
 * Variables opcionales: RADAR_E2E_ELECTRON (ejecutable de Electron, si no es
 * el de node_modules) y RADAR_E2E_KEEP=1 (no borrar la carpeta temporal).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(appDir, '..', '..');
const shotsDir = path.join(appDir, 'e2e', 'capturas');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'radar-e2e-'));
const repo = path.join(tmp, 'tienda');
const FAKE_KEY = `sk-or-v1-${'a1'.repeat(32)}`;
const SECRET_IN_DEMO = 'Xk9#mP2vL8qR4nT7';

function git(...args: string[]): void {
  execFileSync('git', args, {
    cwd: repo,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Ana', GIT_AUTHOR_EMAIL: 'ana@example.com', GIT_COMMITTER_NAME: 'Ana', GIT_COMMITTER_EMAIL: 'ana@example.com' },
  });
}

/** Copia del repositorio de ejemplo con algo de historial (para los puntos críticos). */
function createRepo(): void {
  cpSync(path.join(rootDir, 'examples', 'demo-repo'), repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'inicio');
  for (let i = 1; i <= 3; i++) {
    writeFileSync(path.join(repo, 'src/pedidos/procesarPedido.ts'), `${readFileSync(path.join(repo, 'src/pedidos/procesarPedido.ts'), 'utf8')}// ajuste ${i}\n`);
    git('commit', '-qam', `ajuste ${i}`);
  }
}

let step = 0;
async function shot(page: Page, name: string): Promise<void> {
  step++;
  await page.screenshot({ path: path.join(shotsDir, `${String(step).padStart(2, '0')}-${name}.png`), animations: 'disabled' });
}

function log(message: string): void {
  console.log(`  ✓ ${message}`);
}

/**
 * Sustituye en el proceso principal el cifrado del sistema (si no hay llavero,
 * como en Linux sin escritorio) y fetch por un OpenRouter simulado.
 */
async function simulate(app: ElectronApplication): Promise<void> {
  // tsx conserva los nombres de las funciones con un ayudante __name que no viaja con el código evaluado.
  await app.evaluate('globalThis.__name = (fn) => fn');
  await app.evaluate(
    ({ dialog, safeStorage }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
      if (!safeStorage.isEncryptionAvailable()) {
        safeStorage.isEncryptionAvailable = () => true;
        safeStorage.encryptString = (text: string) => Buffer.from(`simulado:${Buffer.from(text).toString('base64')}`);
        safeStorage.decryptString = (data: Buffer) => Buffer.from(data.toString().slice(9), 'base64').toString();
      }
      const g = globalThis as unknown as { requests: Array<{ url: string; body: string }> };
      g.requests = [];
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input instanceof Request ? input.url : input);
        g.requests.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
        if (url.endsWith('/api/v1/models')) {
          const free = { prompt: '0', completion: '0' };
          return json({
            data: [
              { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder', context_length: 262000, pricing: free, supported_parameters: ['structured_outputs'] },
              { id: 'nvidia/nemotron-nano-9b-v2:free', name: 'Nemotron Nano', context_length: 128000, pricing: free, supported_parameters: ['structured_outputs', 'reasoning'], reasoning: { mandatory: false } },
              { id: 'deepseek/deepseek-r1:free', name: 'R1', context_length: 164000, pricing: free, supported_parameters: ['structured_outputs', 'reasoning'], reasoning: { mandatory: true } },
              { id: 'google/gemini-3-flash', name: 'Gemini 3 Flash', context_length: 1000000, pricing: { prompt: '0.0000003', completion: '0.0000025' }, supported_parameters: ['structured_outputs'] },
            ],
          });
        }
        if (url.endsWith('/api/v1/key')) return json({ data: { limit_remaining: null, usage: 0, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } });
        if (url.endsWith('/api/v1/chat/completions')) {
          const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }> };
          const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
          const id = /El id del hallazgo es "([^"]+)"/.exec(body.messages.map((m) => m.content).join('\n'))?.[1];
          const reply = (content: string): Response => json({ model: body.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 120, cost: 0 } });
          if (system.includes('responde preguntas')) return reply('Empieza por [H2], el punto crítico, después de añadir pruebas ([H1]).');
          if (system.includes('corrección más pequeña')) {
            // Sustituye la rama de la electrónica (líneas 16-29 del ejemplo) por una llamada.
            return reply(
              JSON.stringify({
                id_hallazgo: id,
                aplicable: true,
                resumen: 'Extraer el descuento de la electrónica.',
                cambios: [{ archivo: 'src/pedidos/procesarPedido.ts', linea_inicio: 17, linea_fin: 29, reemplazo: '        total += item.precio * item.cantidad * factorElectronica(item.precio, pedido.cliente);' }],
                riesgos: ['Falta definir factorElectronica.'],
                verificacion: ['Pruebas de procesarPedido.'],
              }),
            );
          }
          const content = JSON.stringify({
            id_hallazgo: id,
            resumen: 'Explicación simulada: la función mezcla demasiadas decisiones.',
            causa_raiz: 'Se añadieron casos especiales sin extraerlos.',
            recomendacion: 'Extraer el cálculo de descuentos a funciones con pruebas propias.',
            afirmaciones: [],
            confianza: 'media',
            informacion_insuficiente: false,
          });
          await new Promise((r) => setTimeout(r, 500));
          return json({ model: body.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 120, cost: 0 } });
        }
        return json({ error: { message: `Sin simular: ${url}` } }, 404);
      };
    },
    repo,
  );
}

async function analyze(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Analizar', exact: true }).click();
  const notice = page.locator('.notice').first();
  await notice.waitFor({ timeout: 60_000 });
  assert.equal(await notice.getAttribute('data-tone'), 'ok', `El análisis no terminó bien: ${await notice.textContent()}`);
  await page.getByRole('button', { name: 'Cerrar aviso' }).click();
}

async function main(): Promise<void> {
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    throw new Error('El sandbox de Chromium no funciona como root: ejecuta la prueba con un usuario normal.');
  }
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  createRepo();
  const executablePath = process.env['RADAR_E2E_ELECTRON'] ?? (createRequire(import.meta.url)('electron') as string);
  const app = await electron.launch({
    executablePath,
    args: [appDir],
    env: { ...process.env, RADAR_DATA_DIR: path.join(tmp, 'datos'), RADAR_CACHE_DIR: path.join(tmp, 'cache') },
  });
  const problems: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await simulate(app);

    // Aislamiento de la interfaz: sin Node y solo la API declarada.
    const surface = await page.evaluate(() => {
      const w = globalThis as unknown as { require?: unknown; process?: unknown; radar: object; location: { origin: string } };
      return { require: typeof w.require, process: typeof w.process, api: Object.keys(w.radar).sort(), origin: w.location.origin };
    });
    assert.deepEqual(surface, { require: 'undefined', process: 'undefined', api: ['ai', 'analyses', 'app', 'chat', 'files', 'jobs', 'projects', 'secrets', 'settings'], origin: 'app://radar' });
    log('la interfaz no tiene acceso a Node y solo ve window.radar');

    await page.getByRole('heading', { name: 'Añade tu primer proyecto' }).waitFor();
    await shot(page, 'bienvenida');
    await page.getByRole('button', { name: 'Añadir carpeta' }).first().click();
    await page.getByRole('heading', { name: 'tienda', level: 1 }).waitFor();
    await analyze(page);
    const blips = await page.locator('.radar-blip').count();
    assert.ok(blips > 5, `El radar debería mostrar hallazgos (hay ${blips})`);
    await shot(page, 'panel');
    log(`análisis completo: ${blips} hallazgos en el radar`);

    await page.getByRole('button', { name: /^Hallazgos/ }).click();
    await page.locator('.finding-row', { hasText: 'Función difícil de mantener' }).first().click();
    await page.locator('.code-line').first().waitFor();
    await shot(page, 'hallazgo');
    log('detalle de un hallazgo con su código');

    await page.getByRole('button', { name: 'Archivos', exact: true }).click();
    await page.locator('.tree-row').first().waitFor();
    await shot(page, 'archivos');

    // Segundo análisis tras quitar el secreto: el historial lo muestra como resuelto.
    const registro = path.join(repo, 'src/clientes/registro.ts');
    writeFileSync(registro, readFileSync(registro, 'utf8').replace(/^const DB_PASSWORD = .*$/m, 'const DB_PASSWORD = process.env.DB_PASSWORD;'));
    git('commit', '-qam', 'sin secreto');
    await analyze(page);
    await page.getByRole('button', { name: /^Historial/ }).click();
    await page.locator('.compare-summary').waitFor();
    const resolved = await page.locator('.compare-columns').textContent();
    assert.match(resolved ?? '', /secreto/i, 'La comparación debería incluir el secreto resuelto');
    await shot(page, 'historial');
    log('historial y comparación entre análisis');

    // Sin modelo configurado, pedir la explicación lleva a Configuración.
    await page.getByRole('button', { name: /^Hallazgos/ }).click();
    await page.locator('.finding-row', { hasText: 'Función difícil de mantener' }).first().click();
    await page.getByRole('button', { name: 'Explicar con IA' }).click();
    assert.match((await page.locator('.ai-ask .form-error').textContent()) ?? '', /Elige un modelo/);
    await page.locator('.ai-ask').getByRole('button', { name: 'Configuración' }).click();
    await page.getByRole('heading', { name: 'Configuración', level: 1 }).waitFor();
    await shot(page, 'configuracion');

    await page.getByRole('button', { name: 'Elegir de la lista' }).click();
    await page.getByLabel('Solo gratuitos').check();
    const rows = page.locator('.catalog-table tbody tr');
    assert.equal(await rows.count(), 2, 'Gratuitos, con salida estructurada y sin razonamiento obligatorio');
    await rows.filter({ hasText: 'qwen/qwen3-coder:free' }).getByRole('button', { name: 'Usar' }).click();
    await page.getByLabel(/Permitir proveedores que guardan/).check();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await page.locator('.save-bar', { hasText: 'Cambios guardados' }).waitFor();
    log('modelo gratuito elegido del catálogo y ajustes guardados');

    const secret = page.locator('.secret', { hasText: 'Clave de OpenRouter' });
    await page.getByLabel('Clave de OpenRouter').fill(FAKE_KEY);
    await secret.getByRole('button', { name: 'Guardar' }).click();
    await secret.getByText('Guardada y cifrada').waitFor();
    assert.equal((await page.content()).includes(FAKE_KEY), false, 'La clave no debe volver a la interfaz');
    await secret.getByRole('button', { name: 'Comprobar' }).click();
    assert.match((await page.locator('.secret-ok').textContent()) ?? '', /47 de 50/);
    await page.locator('#s-claves').scrollIntoViewIfNeeded();
    await shot(page, 'credenciales');
    log('clave guardada cifrada, sin volver a mostrarse, y comprobada');

    await page.getByRole('button', { name: /^Hallazgos/ }).click();
    await page.locator('.finding-row', { hasText: 'Función difícil de mantener' }).first().click();
    await page.getByRole('button', { name: 'Explicar con IA' }).click();
    await page.locator('.detail .ai', { hasText: 'Explicación simulada' }).waitFor({ timeout: 30_000 });
    await page.locator('.detail .ai').scrollIntoViewIfNeeded();
    await shot(page, 'explicacion');

    // Privacidad por defecto (solo metadatos): ni el código ni el secreto salen del equipo.
    const requests = await app.evaluate(() => (globalThis as unknown as { requests: Array<{ url: string; body: string }> }).requests);
    const chats = requests.filter((r) => r.url.endsWith('/chat/completions'));
    assert.equal(chats.length, 1, 'Una sola petición: el hallazgo pedido, sin plan');
    const code = readFileSync(path.join(repo, 'src/pedidos/procesarPedido.ts'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 30);
    for (const r of chats) {
      assert.match(r.body, /procesarPedido/, 'La petición lleva los metadatos del hallazgo');
      for (const line of code) assert.equal(r.body.includes(line), false, `Se envió código a la IA: ${line}`);
      assert.equal(r.body.includes(SECRET_IN_DEMO), false, 'Se envió el secreto a la IA');
    }
    log('explicación de la IA guardada en el análisis, sin enviar código');

    // Propuesta de corrección: con «solo metadatos», primero se pide permiso mostrando lo que sale.
    await page.getByRole('button', { name: 'Proponer una corrección' }).click();
    const consent = page.getByRole('dialog', { name: /Enviar este fragmento de código a OpenRouter/ });
    await consent.waitFor();
    assert.match((await consent.textContent()) ?? '', /src\/pedidos\/procesarPedido\.ts, líneas 1–/);
    await consent.locator('summary').click();
    assert.ok(((await consent.locator('.consent-text').textContent()) ?? '').includes("if (item.categoria === 'electronica') {"), 'La vista previa muestra el código que se enviará');
    await shot(page, 'permiso-envio');
    await consent.getByRole('button', { name: /^Enviar el fragmento/ }).click();
    await page.locator('.diff-line[data-kind="added"]', { hasText: 'factorElectronica' }).waitFor({ timeout: 30_000 });
    await page.locator('.fix').scrollIntoViewIfNeeded();
    await shot(page, 'propuesta');
    await page.getByRole('button', { name: 'Copiar el parche' }).click();
    await page.getByText('Parche copiado al portapapeles.').waitFor();
    const patch = await app.evaluate(({ clipboard }) => clipboard.readText());
    writeFileSync(path.join(tmp, 'cambio.patch'), patch);
    execFileSync('git', ['apply', '--check', path.join(tmp, 'cambio.patch')], { cwd: repo });
    log('propuesta de corrección con permiso explícito; el parche se aplica con git apply');

    // Preguntas: solo datos del análisis; las referencias llevan al hallazgo.
    await page.getByRole('button', { name: /^Preguntar/ }).click();
    await page.getByRole('button', { name: '¿Por dónde empiezo a reducir la deuda?' }).click();
    await page.locator('.msg-refs').waitFor({ timeout: 30_000 });
    await shot(page, 'preguntar');
    const asked = (await app.evaluate(() => (globalThis as unknown as { requests: Array<{ url: string; body: string }> }).requests)).filter((r) => r.url.endsWith('/chat/completions')).at(-1);
    for (const line of code) assert.equal(asked?.body.includes(line), false, `Se envió código al preguntar: ${line}`);
    await page.locator('.ref-inline', { hasText: 'H2' }).click();
    await page.getByRole('heading', { name: /Función difícil de mantener/ }).waitFor();
    log('pregunta respondida sin enviar código; la referencia abre el hallazgo');

    assert.deepEqual(problems, [], `Errores en la consola de la interfaz:\n${problems.join('\n')}`);
  } finally {
    await app.close();
    if (process.env['RADAR_E2E_KEEP'] === '1') console.log(`Datos de la prueba en ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`Prueba de la aplicación superada. Capturas en ${path.relative(process.cwd(), shotsDir) || '.'}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
