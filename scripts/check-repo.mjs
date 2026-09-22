#!/usr/bin/env node
/**
 * 仓库卫生检查：防止大文件 / 误提交产物进入 git 历史。
 *
 * 背景：曾出现「改了产物文件名但 .gitignore 没同步」导致 88MB exe 被提交的事故。
 * 本脚本在提交前运行，断言：
 *   1. 没有任何被 git 跟踪的文件超过阈值（默认 5 MiB）
 *   2. 没有被跟踪的路径命中产物/依赖黑名单（node_modules、release、build、dist、日志、配置）
 *   3. 关键文件存在且非空（server.mjs / web/index.html / desktop/main.mjs / tools/*.exe）
 *
 * 用法：
 *   node scripts/check-repo.mjs            # 检查
 *   node scripts/check-repo.mjs --staged   # 只检查已暂存内容（可作为 pre-commit 钩子）
 * 退出码：0 通过 / 1 有问题
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const stagedOnly = process.argv.includes("--staged");
const MAX_BYTES = 5 * 1024 * 1024;

const git = (args) => execFileSync("git", args, { cwd: APP, encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);

const bad = [];
const warn = [];

// 1) 被跟踪的文件清单（--staged 时只看暂存区）
let files;
try {
	files = stagedOnly ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]) : git(["ls-files"]);
} catch (error) {
	console.error("[check-repo] 无法读取 git 文件清单：", String(error?.message ?? error));
	process.exit(1);
}

// 2) 黑名单：这些路径绝不该被跟踪
const BLOCKED = [
	/^node_modules\//,
	/^release\//,
	/^build\//,
	/^dist\//,
	/\.log$/,
	/^config\.json$/,
	/^RELEASE_NOTES\.md$/,
	/^\.env/,
	/\.exe\.bak$/,
	/\.blob$/,
	/^sea-config\.json$/,
];
// 允许跟踪的 exe（体积小、属于交付物）
const ALLOWED_EXE = /^tools\/(AudioEndpoint|AudioRender)\.exe$/;

for (const file of files) {
	if (BLOCKED.some((re) => re.test(file)) && !ALLOWED_EXE.test(file)) {
		bad.push(`不应入库的路径：${file}`);
		continue;
	}
	let size = 0;
	try {
		size = statSync(join(APP, file)).size;
	} catch {
		// 暂存区里已删除或仅存在于索引：跳过体积检查
		continue;
	}
	if (size > MAX_BYTES && !ALLOWED_EXE.test(file)) {
		bad.push(`文件过大：${file}（${(size / 1048576).toFixed(1)} MiB > ${MAX_BYTES / 1048576} MiB）`);
	} else if (size > 1024 * 1024) {
		warn.push(`较大文件：${file}（${(size / 1048576).toFixed(2)} MiB）`);
	}
}

// 3) 关键文件存在性
const REQUIRED = [
	"server.mjs",
	"desktop/main.mjs",
	"desktop/preload.cjs",
	"web/index.html",
	"tools/AudioEndpoint.exe",
	"tools/AudioRender.exe",
	"package.json",
	"README.md",
	"LICENSE",
	".gitignore",
	".gitattributes",
	".npmrc",
];
for (const rel of REQUIRED) {
	const p = join(APP, rel);
	if (!existsSync(p)) bad.push(`缺少必需文件：${rel}`);
	else if (statSync(p).size === 0) bad.push(`文件为空：${rel}`);
}

// 4) 历史里是否残留大对象（只看当前可达对象的总包体，仅提示）
try {
	const pack = execFileSync("git", ["count-objects", "-vH"], { cwd: APP, encoding: "utf8" });
	const m = /size-pack:\s*([\d.]+)\s*(\w+)/.exec(pack);
	if (m) {
		const value = Number(m[1]);
		const unit = m[2];
		const inMiB = unit === "GiB" ? value * 1024 : unit === "KiB" ? value / 1024 : value;
		if (inMiB > 30) warn.push(`git 包体偏大：${m[1]} ${unit}（可能有历史残留大文件，可用 filter-branch 清理）`);
	}
} catch {
	/* 忽略 */
}

for (const w of warn) console.log(`[check-repo] 提示：${w}`);
if (bad.length > 0) {
	console.error(`[check-repo] 未通过（${bad.length} 项）：`);
	for (const b of bad) console.error("   -", b);
	process.exit(1);
}
console.log(`[check-repo] 通过：检查了 ${files.length} 个文件，无超限/黑名单/缺失项。`);
