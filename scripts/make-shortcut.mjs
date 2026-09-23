#!/usr/bin/env node
/**
 * 生成快捷方式：桌面 + 开始菜单，并带上自定义图标。
 *
 * 优先指向 **Electron 桌面版**（release 里的便携版），原因：
 *   - 窗口/任务栏使用应用自己的图标（单文件版由 Chrome 承载界面，任务栏只能是浏览器图标）
 *   - 关闭窗口 = 收进托盘，不在任务栏占位
 * 若 Electron 产物不存在，则退回单文件版（功能可用，但任务栏图标是浏览器的）。
 *
 * 用法：node scripts/make-shortcut.mjs [--remove]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const ICO = join(APP, "assets", "app.ico");
const NAME = "432Hz 播放器.lnk";

/** 在 release/ 里找最新一版便携版（优先 Electron，图标与托盘行为正确）。 */
function findPortable() {
	const dir = join(APP, "release");
	if (!existsSync(dir)) return null;
	const found = readdirSync(dir)
		.filter((f) => /^432hz-player-[\d.]+-portable\.exe$/.test(f))
		.map((f) => ({ f, v: f.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "0.0.0" }))
		.sort((a, b) => b.v.localeCompare(a.v, undefined, { numeric: true }));
	return found.length > 0 ? join(dir, found[0].f) : null;
}

const portable = findPortable();
const standalone = join(APP, "432hz-player-standalone.exe");
const EXE = portable ?? (existsSync(standalone) ? standalone : null);

const targets = [
	join(homedir(), "Desktop", NAME),
	join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", NAME),
];

const remove = process.argv.includes("--remove");

if (remove) {
	for (const path of targets) {
		try {
			if (existsSync(path)) rmSync(path, { force: true });
			console.log("removed:", path);
		} catch (error) {
			console.error("删除失败:", path, String(error?.message ?? error));
		}
	}
	process.exit(0);
}

if (EXE === null) {
	console.error("找不到可执行文件：请先运行 npm run dist（或 node scripts/build-exe.mjs）");
	process.exit(1);
}
console.log("快捷方式目标:", EXE, portable !== null ? "（Electron 桌面版）" : "（单文件版：任务栏图标为浏览器图标）");

/** 用 PowerShell 的 WScript.Shell 创建 .lnk */
function createShortcut(path) {
	const q = (s) => String(s).replace(/'/g, "''");
	const icon = existsSync(ICO) ? ICO : EXE;
	const script = [
		"$ws = New-Object -ComObject WScript.Shell;",
		`$lnk = $ws.CreateShortcut('${q(path)}');`,
		`$lnk.TargetPath = '${q(EXE)}';`,
		"$lnk.Arguments = '';",
		`$lnk.WorkingDirectory = '${q(APP)}';`,
		"$lnk.Description = '432Hz 播放器：把系统音频转成 432Hz 输出（点击启动）';",
		`$lnk.IconLocation = '${q(icon)},0';`,
		"$lnk.WindowStyle = 1;",
		"$lnk.Save();",
	].join(" ");
	execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "inherit" });
}

for (const path of targets) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		createShortcut(path);
		console.log(existsSync(path) ? "created:" : "!! 未生成:", path);
	} catch (error) {
		console.error("创建失败:", path, String(error?.message ?? error));
	}
}
