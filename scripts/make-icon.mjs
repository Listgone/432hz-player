// 生成应用图标 assets/app.ico —— 纯代码画图，不依赖任何图形库。
// 图案：深色圆底 + 青色声波弧 + 中心 432 刻度点（16/32/48/256 四个尺寸，PNG 帧打包进 ICO）。
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "assets", "app.ico");

/** CRC32（PNG 需要） */
const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let i = 0; i < 256; i += 1) {
		let c = i;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c;
	}
	return table;
})();
function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}
/** RGBA 像素 → PNG buffer */
function toPng(size, rgba) {
	const raw = Buffer.alloc((size * 4 + 1) * size);
	for (let y = 0; y < size; y += 1) {
		raw[y * (size * 4 + 1)] = 0; // filter: none
		rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** 画一个尺寸下的图标像素（抗锯齿用 3x3 超采样） */
function render(size) {
	const rgba = Buffer.alloc(size * size * 4);
	const cx = (size - 1) / 2;
	const cy = (size - 1) / 2;
	const radius = size * 0.46;
	const ringOuter = size * 0.40;
	const ringInner = size * 0.30;
	const arcRadius = size * 0.24;
	const arcThickness = Math.max(1.2, size * 0.075);
	const samples = 3;
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let sy = 0; sy < samples; sy += 1) {
				for (let sx = 0; sx < samples; sx += 1) {
					const px = x + (sx + 0.5) / samples - 0.5;
					const py = y + (sy + 0.5) / samples - 0.5;
					const dx = px - cx;
					const dy = py - cy;
					const dist = Math.sqrt(dx * dx + dy * dy);
					// 底：深色圆
					if (dist <= radius) {
						r += 18; g += 22; b += 29; a += 255;
					}
					// 外环：青色
					if (dist <= ringOuter && dist >= ringInner) {
						r += 53; g += 208; b += 165; a += 255;
					}
					// 中心声波弧（从左上到右下的一段圆弧，模拟“432”刻度）
					if (Math.abs(dist - arcRadius) <= arcThickness / 2) {
						const ang = Math.atan2(dy, dx);
						if (ang > -2.5 && ang < 0.9) {
							r += 233; g += 240; b += 246; a += 255;
						}
					}
					// 中心点
					if (dist <= Math.max(1, size * 0.05)) {
						r += 233; g += 240; b += 246; a += 255;
					}
				}
			}
			const n = samples * samples;
			const i = (y * size + x) * 4;
			rgba[i] = Math.min(255, Math.round(r / n) * 1);
			rgba[i + 1] = Math.min(255, Math.round(g / n));
			rgba[i + 2] = Math.min(255, Math.round(b / n));
			rgba[i + 3] = Math.min(255, Math.round(a / n));
		}
	}
	return rgba;
}

const sizes = [16, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, png: toPng(size, render(size)) }));

// ICO 容器：ICONDIR + ICONDIRENTRY*n + PNG 数据（Vista+ 支持 PNG 帧）
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = 6 + pngs.length * 16;
const entries = [];
for (const { size, png } of pngs) {
	const entry = Buffer.alloc(16);
	entry[0] = size >= 256 ? 0 : size;
	entry[1] = size >= 256 ? 0 : size;
	entry[2] = 0;
	entry[3] = 0;
	entry.writeUInt16LE(1, 4);
	entry.writeUInt16LE(32, 6);
	entry.writeUInt32LE(png.length, 8);
	entry.writeUInt32LE(offset, 12);
	entries.push(entry);
	offset += png.length;
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]));
console.log(`wrote ${OUT} (${sizes.join("/")} → ${(offset / 1024).toFixed(1)} KiB)`);
