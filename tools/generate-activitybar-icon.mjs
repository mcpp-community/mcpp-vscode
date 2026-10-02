#!/usr/bin/env node
/**
 * `images/logo.png` -> `images/activity-bar.png`, the mark the activity bar
 * draws in the theme's own colour.
 *
 * **Why this file exists.** VS Code does not paint a container icon as an
 * ordinary image. `ActivityAction` builds a per-icon class whose rule is
 * `mask: url(<icon>) no-repeat 50% 50%` with `mask-size: 24px`, so the icon's
 * **alpha channel** becomes a stencil and the colour comes from the theme
 * (`--vscode-activityBar-inactiveForeground`, `--vscode-activityBar-foreground`
 * on hover). The official logo is a 377x377 opaque black rounded square with the
 * wordmark on it: as a stencil that is a solid white block, which is exactly
 * what shipped and exactly what a reviewer saw.
 *
 * So the asset is derived rather than drawn by hand. Two properties matter:
 *
 * 1. **The background is transparent and only the wordmark is opaque.** The
 *    badge disappears; the letters become the stencil.
 * 2. **The glyph is white.** Against a transparent background that is correct
 *    under an alpha mask (*the* behaviour) *and* under a luminance one, so the
 *    icon cannot break if the masking mode is ever the other of the two.
 *
 * The extraction is a coverage estimate, not a trace: the wordmark is drawn in
 * two flat colours (#f08c00 and #1971c2) over black, so a pixel is
 * `coverage * colour` per channel, and the largest channel relative to that
 * channel's value in the pure colour recovers the coverage. Anything under 6%
 * is the badge's own edge antialiasing and is dropped.
 *
 * `--check` re-derives the file in memory and exits 1 on any difference;
 * `npm run check:icon` and `test/views/activityBarIcon.test.ts` use it, so the
 * committed PNG cannot drift from the logo it came from.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(root, "images", "logo.png");
const TARGET = path.join(root, "images", "activity-bar.png");

/**
 * The wordmark's two flat colours (#f08c00 and #1971c2), reduced to the divisor
 * each one contributes below.
 */
const INK_DIVISORS = [240, 140, 194];

/** Below this much coverage a pixel is the badge edge, not the wordmark. */
const NOISE_FLOOR = 0.06;

/** The output canvas: 96 px wide, so a 4 px margin is 1 px at the 24 px mask. */
const MARGIN = 4;
const CONTENT_WIDTH = 88;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * A PNG this script can read: 8-bit RGBA, non-interlaced. Anything else is
 * refused rather than approximated — a silently mis-read logo is worse than a
 * failed build.
 */
function decodePng(buffer) {
  if (buffer.subarray(0, 8).toString("binary") !== "\x89PNG\r\n\x1a\n") {
    throw new Error(`${SOURCE}: not a PNG`);
  }
  let offset = 8;
  let header;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (header === undefined) {
    throw new Error(`${SOURCE}: no IHDR`);
  }
  if (header.depth !== 8 || header.colorType !== 6 || header.interlace !== 0) {
    throw new Error(
      `${SOURCE}: expected an 8-bit RGBA, non-interlaced PNG (got depth ${header.depth}, colour type ${header.colorType}, interlace ${header.interlace})`,
    );
  }
  const { width, height } = header;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;
    const line = raw.subarray(position, position + stride);
    position += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= 4 ? out[i - 4] : 0;
      const b = previous[i];
      const c = i >= 4 ? previous[i - 4] : 0;
      const x = line[i];
      let value;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else {
        throw new Error(`${SOURCE}: unknown filter type ${filter} on row ${y}`);
      }
      out[i] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

/**
 * How much of the wordmark's ink covers this pixel, 0..1.
 *
 * Nothing here is a guess about the artwork: the wordmark is painted in exactly
 * two flat colours over a pure black field, so a pixel is `coverage * ink` and
 * one channel of the pure ink recovers the coverage exactly. The three divisors
 * are the largest channel of each ink — #f08c00's red and green, #1971c2's blue
 * — so the largest ratio is 1 for either ink, 0 for the black field (which is
 * why the badge, whose edge antialiases against transparency at rgb 0,0,0,
 * vanishes rather than leaving a halo), and never divides by zero.
 */
function coverage(r, g, b) {
  const value = Math.max(r / INK_DIVISORS[0], g / INK_DIVISORS[1], b / INK_DIVISORS[2]);
  return value < NOISE_FLOOR ? 0 : Math.min(1, value);
}

/** The wordmark as a coverage field, plus the box it actually occupies. */
function wordmark(png) {
  const { width, height, pixels } = png;
  const field = new Float64Array(width * height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      if (pixels[at + 3] <= 8) continue;
      const value = coverage(pixels[at], pixels[at + 1], pixels[at + 2]);
      if (value <= 0) continue;
      field[y * width + x] = value;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    throw new Error(`${SOURCE}: no wordmark ink was found`);
  }
  return { field, minX, minY, maxX, maxY };
}

/**
 * The icon: the wordmark fitted to the content width, centred on a transparent
 * canvas trimmed to its own height, as white with a coverage alpha.
 *
 * The canvas is **not** square. The mask is sized by width alone
 * (`mask-size: 24px`), so a square canvas would only shrink a 1.85:1 wordmark
 * to fit its height. Trimming to the glyph's own aspect keeps it as large as the
 * 24 px box allows.
 */
function render(png) {
  const { field, minX, minY, maxX, maxY } = wordmark(png);
  const sourceWidth = maxX - minX + 1;
  const sourceHeight = maxY - minY + 1;
  const contentHeight = Math.max(2, Math.round((CONTENT_WIDTH * sourceHeight) / sourceWidth / 2) * 2);
  const width = CONTENT_WIDTH + 2 * MARGIN;
  const height = contentHeight + 2 * MARGIN;

  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < contentHeight; y += 1) {
    for (let x = 0; x < CONTENT_WIDTH; x += 1) {
      // Box filter: the source box is much larger than one output pixel here, so
      // averaging is the whole of the antialiasing.
      const x0 = minX + (x * sourceWidth) / CONTENT_WIDTH;
      const x1 = minX + ((x + 1) * sourceWidth) / CONTENT_WIDTH;
      const y0 = minY + (y * sourceHeight) / contentHeight;
      const y1 = minY + ((y + 1) * sourceHeight) / contentHeight;
      let total = 0;
      let samples = 0;
      for (let sy = Math.floor(y0); sy <= Math.min(Math.ceil(y1) - 1, maxY); sy += 1) {
        for (let sx = Math.floor(x0); sx <= Math.min(Math.ceil(x1) - 1, maxX); sx += 1) {
          total += field[sy * png.width + sx];
          samples += 1;
        }
      }
      const value = samples === 0 ? 0 : total / samples;
      alpha[(MARGIN + y) * width + (MARGIN + x)] = Math.round(value * 255);
    }
  }

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4;
      // White, fully opaque where the stencil is: correct as an alpha mask and
      // as a luminance one.
      raw[at] = 255;
      raw[at + 1] = 255;
      raw[at + 2] = 255;
      raw[at + 3] = alpha[y * width + x];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "binary"),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const generated = render(decodePng(fs.readFileSync(SOURCE)));
const relative = path.relative(root, TARGET);

if (process.argv.includes("--check")) {
  const committed = fs.existsSync(TARGET) ? fs.readFileSync(TARGET) : Buffer.alloc(0);
  if (!generated.equals(committed)) {
    console.error(`error: ${relative} is out of date — run \`npm run gen:icon\` and commit the result`);
    process.exit(1);
  }
  console.log(`check-generators: ${relative} matches ${path.relative(root, SOURCE)}`);
} else {
  fs.writeFileSync(TARGET, generated);
  console.log(`generate-activitybar-icon: wrote ${relative} (${generated.length} bytes)`);
}
