/**
 * Genera los iconos de la aplicación a partir de build/icon.svg, con el propio
 * Electron como rasterizador (sin dependencias nuevas):
 *
 * - build/icon.ico: Windows, con todos los tamaños que usa el sistema (de 16 a 256 px);
 * - build/icon.png: 512 px, para el resto de plataformas.
 *
 * Uso: npm run icon -w @radar/desktop (los dos archivos se guardan en Git: solo
 * hay que regenerarlos si cambia el SVG).
 */
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const PNG_SIZE = 512;
const buildDir = path.join(__dirname, '..', 'build');

/** Un ICO con las imágenes en PNG (admitido desde Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // tipo: icono
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 significa 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // sin paleta
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // planos
    e.writeUInt16LE(32, 6); // bits por píxel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function render(win, svg, size) {
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block}</style></head><body><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
  win.setContentSize(size, size);
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  const { width, height } = image.getSize();
  if (width !== size || height !== size) throw new Error(`Captura de ${width}×${height} en lugar de ${size}×${size}.`);
  return image.toPNG();
}

app.disableHardwareAcceleration();
app
  .whenReady()
  .then(async () => {
    const svg = readFileSync(path.join(buildDir, 'icon.svg'), 'utf8');
    const win = new BrowserWindow({ show: false, frame: false, transparent: true, backgroundColor: '#00000000', useContentSize: true, webPreferences: { offscreen: true } });
    win.webContents.setFrameRate(1);
    const images = [];
    for (const size of ICO_SIZES) images.push({ size, png: await render(win, svg, size) });
    writeFileSync(path.join(buildDir, 'icon.ico'), ico(images));
    writeFileSync(path.join(buildDir, 'icon.png'), await render(win, svg, PNG_SIZE));
    console.log(`Iconos generados en ${buildDir}: icon.ico (${ICO_SIZES.join(', ')} px) e icon.png (${PNG_SIZE} px).`);
    app.quit();
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
