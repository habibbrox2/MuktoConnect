/**
 * Builds the MuktoConnect brand binaries from the SVG sources.
 *
 *   npm run brand:build
 *
 * The mark (assets/icon.svg) is a calligraphic Bangla ম whose matra flows
 * into the crown of MuktoDwar's gate, with the official GitHub Copilot Chat
 * logo (assets/copilot-chat.svg) on the flag-red disc in the doorway, all on
 * a Bangladesh-green field. Glyphs need Nirmala UI at build time. Everything
 * else is vector, rendered straight from the sources by resvg; sharp is only
 * used to bake the surface colour into the lockup PNGs.
 *
 * Outputs:
 *   assets/icon.png            128x128  (VS Code extension icon)
 *   assets/icon-256.png        256x256
 *   assets/icon-512.png        512x512
 *   assets/logo-dark.png       1280x360 lockup for dark surfaces
 *   assets/logo-light.png      1280x360 lockup for light surfaces
 *   assets/muktoconnect.ico    16/32/48/64/128/256 Windows icon
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'assets');
mkdirSync(assets, { recursive: true });

const LOCKUP_WIDTH = 1280;

function renderSvg(svgPath, width) {
  const svg = readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Segoe UI',
      sansSerifFamily: 'Segoe UI',
      // Keep the Bangla glyph source (Nirmala UI) and fallbacks resolvable.
      cursiveFamily: 'Nirmala UI',
      fantasyFamily: 'Nirmala UI',
      monospaceFamily: 'Nirmala UI',
      serifFamily: 'Nirmala UI',
    },
  });
  return resvg.render().asPng();
}

/** ICO container whose image payloads are PNGs (supported since Windows Vista). */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  let offset = 6 + 16 * pngs.length;
  const entries = [];
  const payloads = [];
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
    payloads.push(data);
  }
  return Buffer.concat([header, ...entries, ...payloads]);
}

for (const [name, size] of [
  ['icon.png', 128],
  ['icon-256.png', 256],
  ['icon-512.png', 512],
]) {
  const png = renderSvg(join(assets, 'icon.svg'), size);
  writeFileSync(join(assets, name), png);
  console.log(`assets/${name}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

for (const name of ['logo-dark.svg', 'logo-light.svg']) {
  const base = renderSvg(join(assets, name), LOCKUP_WIDTH);
  // Bake the surface colour in so the PNG stays readable in any README/theme.
  const surface = name.includes('light') ? '#FFFFFF' : '#003D2E';
  const png = await sharp(base).flatten({ background: surface }).png().toBuffer();
  const out = name.replace('.svg', '.png');
  writeFileSync(join(assets, out), png);
  console.log(`assets/${out}  ${LOCKUP_WIDTH}px wide  ${(png.length / 1024).toFixed(1)} KB`);
}

const icoSizes = [16, 32, 48, 64, 128, 256];
const ico = buildIco(icoSizes.map((size) => ({ size, data: renderSvg(join(assets, 'icon.svg'), size) })));
writeFileSync(join(assets, 'muktoconnect.ico'), ico);
console.log(`assets/muktoconnect.ico  ${icoSizes.join('/')}  ${(ico.length / 1024).toFixed(1)} KB`);
