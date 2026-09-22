#!/usr/bin/env node
/**
 * 打包成单文件 Windows 可执行程序（.exe）。
 *
 * 步骤（全部用 Node 内置能力，不依赖 esbuild/pkg）：
 *   1. 把 server.mjs + web/index.html 合成一个 CommonJS 入口（UI 内联为字符串）
 *   2. 生成 sea-config.json
 *   3. `node --experimental-sea-config` 生成 blob
 *   4. 复制 node.exe → 432hz-player-standalone.exe，用 postject 注入 blob
 *   5. （可选）用 rcedit 写入图标与版本信息
 *
 * 用法：node scripts/build-exe.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const BUILD = join(APP, "build");
const DIST = join(APP, "dist");
const NODE_EXE = process.execPath;

const log = (...a) => console.log("[build-exe]", ...a);
const run = (file, args, options = {}) => {
	const result = spawnSync(file, args, { stdio: "inherit", ...options });
	if (result.status !== 0) throw new Error(`${file} ${args.join(" ")} → exit ${result.status}`);
};

// ---------------------------------------------------------------------------
// PE 头工具：只读/只改 PE 可选头里的字节，**不碰节表、不碰资源树**
//
// 背景（已实测）：node.exe 带 Authenticode 签名，
//   - 新增节（postject 之外再加节）→ Windows 拒绝加载
//   - 原地改资源树（换图标）      → 加载即崩溃
//   - 只改 PE 头数值              → 安全（PE 头不在签名覆盖范围内；签名本来也已被 SEA 注入作废）
// 因此这里只做一件事：把 IMAGE_OPTIONAL_HEADER.Subsystem 从 3(console) 改成 2(GUI)，消除黑色命令行窗口。
// ---------------------------------------------------------------------------
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

/** 从 fd 的 offset 处读 len 字节。 */
function readAt(fd, offset, len) {
	const buffer = Buffer.allocUnsafe(len);
	let read = 0;
	while (read < len) {
		const n = readSync(fd, buffer, read, len - read, offset + read);
		if (n <= 0) throw new Error(`读取 PE 头失败 @${offset}+${read}`);
		read += n;
	}
	return buffer;
}

/** PE 可选头里 Subsystem 字段的绝对文件偏移（x64/x86 通用：可选头 +68）。 */
function subsystemOffset(fd) {
	const dos = readAt(fd, 0, 64);
	if (dos.toString("ascii", 0, 2) !== "MZ") throw new Error("不是 MZ 开头的 PE 文件");
	const peOffset = dos.readUInt32LE(0x3c);
	if (peOffset <= 0 || peOffset > 0x10000000) throw new Error(`非法 e_lfanew=${peOffset}`);
	const head = readAt(fd, peOffset, 4 + 20 + 72);
	if (head.readUInt32LE(0) !== 0x00004550) throw new Error("PE 签名缺失（不是有效 PE）");
	const magic = head.readUInt16LE(24);
	if (magic !== 0x010b && magic !== 0x020b) throw new Error(`未知可选头 magic=0x${magic.toString(16)}`);
	const optSize = head.readUInt16LE(20);
	if (optSize < 70) throw new Error(`可选头过小 optSize=${optSize}`);
	return { offset: peOffset + 24 + 68, magic, optSize };
}

/**
 * 把 exe 的 PE 子系统改成 GUI（无控制台窗口）。幂等：已是 2 就跳过。
 * @param target - 目标 exe 路径。
 * @param options.backup - 是否先备份到 build/（默认 true，失败可回滚）。
 * @returns {{changed:boolean, subsystem:number, backup:string|null, verified:boolean, size:number}}
 */
function patchSubsystem(target, options = {}) {
	const backup = options.backup !== false ? join(BUILD, "pre-subsystem-patch.exe.bak") : null;
	if (backup !== null) {
		copyFileSync(target, backup);
		log("已备份改前副本:", backup, (statSync(backup).size / 1048576).toFixed(1), "MiB");
	}
	const fd = openSync(target, "r+");
	try {
		const info = subsystemOffset(fd);
		const current = readAt(fd, info.offset, 2).readUInt16LE(0);
		if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
			log(`PE Subsystem 已是 GUI(${IMAGE_SUBSYSTEM_WINDOWS_GUI})，跳过`);
			return { changed: false, subsystem: current, backup, verified: true, size: statSync(target).size };
		}
		if (current !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
			throw new Error(`PE Subsystem=${current}（既不是 console(3) 也不是 GUI(2)），拒绝修改`);
		}
		writeSync(fd, Buffer.from([IMAGE_SUBSYSTEM_WINDOWS_GUI, 0]), 0, 2, info.offset);
		// 写完立刻回读校验：GUI 子系统万一没生效，用户双击还是会看到黑窗
		const after = readAt(fd, info.offset, 2).readUInt16LE(0);
		const verified = after === IMAGE_SUBSYSTEM_WINDOWS_GUI;
		log(`PE Subsystem: ${IMAGE_SUBSYSTEM_WINDOWS_CUI}(console) → ${after}(GUI) @偏移 ${info.offset}，回读校验 ${verified ? "通过" : "失败"}`);
		if (!verified) throw new Error(`Subsystem 回读校验失败：期望 ${IMAGE_SUBSYSTEM_WINDOWS_GUI}，实际 ${after}`);
		return { changed: true, subsystem: after, backup, verified, size: statSync(target).size };
	} finally {
		closeSync(fd);
	}
}

// ---------------------------------------------------------------------------
// 1) 生成带内联 UI 的 CJS 入口
// ---------------------------------------------------------------------------
mkdirSync(BUILD, { recursive: true });
mkdirSync(DIST, { recursive: true });

const serverSrc = readFileSync(join(APP, "server.mjs"), "utf8");
const html = readFileSync(join(APP, "web", "index.html"), "utf8");
/** 内联版本号：单文件模式下读不到 package.json，靠这里注入供 /api/export-log 使用。 */
const pkgVersion = (() => {
	try {
		return JSON.parse(readFileSync(join(APP, "package.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

/** ESM → CJS：把 import 语句换成 require，去掉 export 关键字，并剥掉中间位置的 shebang。 */
function toCjs(source) {
	let out = source;
	// shebang 只能出现在文件第 1 行；内联到中间会变成语法错误，先剥掉
	out = out.replace(/^#!.*\r?\n/, "");
	// import { a, b } from "x"  /  import x from "x"
	out = out.replace(/^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?$/gm, (_m, names, mod) => {
		const list = names.split(",").map((s) => s.trim()).filter(Boolean);
		return `const { ${list.join(", ")} } = require("${mod}");`;
	});
	out = out.replace(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?$/gm, (_m, name, mod) => `const ${name} = require("${mod}");`);
	// export function/const → 去掉 export
	out = out.replace(/^export\s+(async\s+)?function\s/gm, "$1function ");
	out = out.replace(/^export\s+const\s/gm, "const ");
	// CJS 里没有 import.meta：换成 __filename（构建时注入的 __filename 指向 exe）
	out = out.replace(/fileURLToPath\(import\.meta\.url\)/g, "__filename");
	return out;
}

const inlined = [
	"// ==== 由 scripts/build-exe.mjs 生成：单文件可执行入口（勿手改） ====",
	"\"use strict\";",
	`globalThis.__HZ432_HTML__ = ${JSON.stringify(html)};`,
	`globalThis.__HZ432_VERSION__ = ${JSON.stringify(pkgVersion)};`,
	toCjs(serverSrc),
].join("\n");

writeFileSync(join(BUILD, "entry.cjs"), inlined, "utf8");
log("entry.cjs 生成:", (inlined.length / 1024).toFixed(1), "KiB");

// ---------------------------------------------------------------------------
// 2) sea-config.json
// ---------------------------------------------------------------------------
const seaConfig = {
	main: join(BUILD, "entry.cjs"),
	output: join(BUILD, "sea-prep.blob"),
	disableExperimentalSEAWarning: true,
	useSnapshot: false,
	useCodeCache: false,
};
writeFileSync(join(BUILD, "sea-config.json"), JSON.stringify(seaConfig, null, 2), "utf8");

// ---------------------------------------------------------------------------
// 3) 生成 blob
// ---------------------------------------------------------------------------
run(NODE_EXE, ["--experimental-sea-config", join(BUILD, "sea-config.json")]);
if (!existsSync(seaConfig.output)) throw new Error("blob 生成失败");
log("blob 生成:", (readFileSync(seaConfig.output).length / 1024).toFixed(1), "KiB");

// ---------------------------------------------------------------------------
// 4) 复制 node.exe 并注入 blob（输出到应用根，与 tools/ 同级）
//
// 关于图标：node.exe 带 Authenticode 签名，任何改动 PE 资源/节表的做法都有风险
// （实测：新增节 → 拒绝加载；原地改资源树 → 加载崩溃）。因此 exe **保持原样**，
// 自定义图标由 Windows 快捷方式承载（快捷方式的 IconLocation 原生支持 .ico），
// 见 scripts/make-shortcut.mjs。文件夹里的 exe 会显示 Node 默认图标，功能不受影响。
// ---------------------------------------------------------------------------
const target = join(APP, "432hz-player-standalone.exe");
copyFileSync(NODE_EXE, target);

const postjectArgs = [
	"postject",
	target,
	"NODE_SEA_BLOB",
	seaConfig.output,
	"--sentinel-fuse",
	"NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
const postject = spawnSync("npx", ["--yes", ...postjectArgs], { stdio: "inherit", shell: true });
if (postject.status !== 0) {
	log("!! postject 注入失败（可能无网络）。已生成中间产物：");
	log("   blob:", seaConfig.output);
	log("   可手动执行: npx --yes postject \"<exe>\" NODE_SEA_BLOB \"<blob>\" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2");
	process.exitCode = 2;
} else {
	log("exe 生成:", target, (readFileSync(target).length / 1048576).toFixed(1), "MiB");
}

// ---------------------------------------------------------------------------
// 4.5) 消除命令行黑窗：把 PE 可选头 Subsystem 3(console) → 2(GUI)
//
// postject 注入会新增/改写节表（那是它自己的活，注入本身没问题），因此本步必须在 postject
// **之后**做；这里只改 PE 头里的 2 个字节，不碰节表、不碰资源树，是唯一安全的做法。
// 副作用：GUI 子系统下进程没有控制台，server.mjs 已把 stdout/stderr 兜底重定向到
// %USERPROFILE%\.432hz-player\stdout.log，服务照常启动。
// ---------------------------------------------------------------------------
if (postject.status === 0) {
	try {
		patchSubsystem(target);
	} catch (error) {
		log("!! PE Subsystem 修改失败：", String(error?.message ?? error));
		const backup = join(BUILD, "pre-subsystem-patch.exe.bak");
		if (existsSync(backup)) {
			log("   回滚改前副本 →", target);
			copyFileSync(backup, target);
		}
		process.exitCode = 4;
	}
}

// ---------------------------------------------------------------------------
// 5) 生成快捷方式（桌面 + 开始菜单），图标由快捷方式承载
// ---------------------------------------------------------------------------
if (postject.status === 0 && (process.exitCode ?? 0) === 0) {
	const shortcutScript = join(HERE, "make-shortcut.mjs");
	const r = spawnSync(NODE_EXE, [shortcutScript], { stdio: "inherit" });
	if (r.status !== 0) log("!! 快捷方式生成失败（可稍后手动运行 scripts/make-shortcut.mjs）");
}
