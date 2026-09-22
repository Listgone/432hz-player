#!/usr/bin/env node
/**
 * 生成快捷方式：桌面 + 开始菜单，指向 dist 里的 432Hz播放器.exe，并带上自定义图标。
 * 图标只能由快捷方式承载（不改 PE，见 scripts/build-exe.mjs 说明）。
 *
 * 用法：node scripts/make-shortcut.mjs [--remove]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const EXE = join(APP, "432Hz播放器.exe");
const ICO = join(APP, "assets", "app.ico");
const NAME = "432Hz 播放器.lnk";

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

if (!existsSync(EXE)) {
	console.error("找不到 exe:", EXE, "\n请先运行 npm run build:exe");
	process.exit(1);
}

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
