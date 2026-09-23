/**
 * Electron 主进程。
 *
 * 职责：
 *   1. 在本进程内启动音频服务（复用 server.mjs 的 startServer，不起子进程、不弹命令行窗口）
 *   2. 开一个无边框式桌面窗口加载本地界面（自带应用图标与任务栏身份）
 *   3. 单实例：第二次点击图标只聚焦已有窗口
 *   4. 托盘：显示状态、快速启停、退出
 *   5. 把「打开数据目录 / 打开外链」交给系统 Shell
 */
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell, dialog } from "electron";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * 应用根解析：
 *   开发态  → 项目根（desktop/ 的上一级）
 *   打包后  → app.getAppPath()，即 `resources/app.asar`；
 *             server.mjs 与 web/ 都在 asar 内，Electron 的 fs 补丁能正常读取。
 *   外部资源 → `resources/tools`（extraResources 释放，可从 asar 外 spawn）。
 */
const ROOT = app.isPackaged ? app.getAppPath() : join(HERE, "..");
const PORT = Number(process.env.HZ432_PORT ?? 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const ICON = join(app.isPackaged ? process.resourcesPath : ROOT, "assets", "app.ico");
const BOOT_LOG = join(homedir(), ".432hz-player", "desktop.log");

/** 主进程诊断日志：写文件，方便排查打包后的启动问题（GUI 下没有控制台）。 */
function note(...parts) {
	const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
	try {
		console.log("[main]", ...parts);
	} catch {
		/* GUI 下可能没有 stdout */
	}
	try {
		appendFileSync(BOOT_LOG, `${line}\n`);
	} catch {
		/* 日志失败不影响启动 */
	}
}

let win = null;
let tray = null;
let server = null;
let quitting = false;

/** 单实例：第二次启动只聚焦已有窗口 */
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (win === null) return;
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
	});
}

/** 启动内嵌音频服务（同进程，无子进程、无控制台窗口）。 */
async function startServer() {
	const serverPath = join(ROOT, "server.mjs");
	const insideAsar = ROOT.includes("app.asar");
	// asar 内的文件用路径判断会显示不存在（native fs 看不到），但 Electron 的 ESM 加载器能 import
	note("startServer: root=", ROOT, "serverPath=", serverPath, "exists=", existsSync(serverPath), "insideAsar=", insideAsar, "isPackaged=", app.isPackaged);
	try {
		const mod = await import(pathToFileURL(serverPath).href);
		note("import OK, exports=", Object.keys(mod).join(","), "hasStartServer=", typeof mod.startServer);
		if (typeof mod.startServer === "function") {
			const result = await mod.startServer({ port: PORT, root: ROOT, openWindow: false });
			note("in-process startServer →", JSON.stringify({ ok: result.ok, port: result.port, error: result.error }));
			server = result;
			return result;
		}
	} catch (error) {
		note("同进程启动失败:", String(error?.stack ?? error));
	}
	// 兜底：用 Electron 自带的 Node 运行时跑 server.mjs（GUI 子系统下无窗口弹出）
	try {
		const child = spawn(process.execPath, [serverPath, "--no-open"], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HZ432_PORT: String(PORT), NODE_OPTIONS: "" },
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", (error) => note("子进程启动错误:", String(error?.message ?? error)));
		note("已启动子进程兜底, pid=", child.pid);
		server = { close: () => { try { child.kill(); } catch { /* ignore */ } } };
		for (let i = 0; i < 40; i += 1) {
			await new Promise((r) => setTimeout(r, 250));
			try {
				const res = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) });
				if ((await res.json())?.ok === true) {
					note("子进程服务就绪");
					return { ok: true, mode: "child", port: PORT, url: BASE, close: server.close };
				}
			} catch {
				/* 继续等 */
			}
		}
		return { ok: false, error: "服务启动超时", port: PORT, url: BASE, close: () => {} };
	} catch (error) {
		note("兜底也失败:", String(error?.message ?? error));
		return { ok: false, error: String(error?.message ?? error), port: PORT, url: BASE, close: () => {} };
	}
}

function createWindow() {
	const log = note;
	/*
	 * 默认尺寸 = 最小尺寸 = 1023×629（界面在此比例下布局完整）。
	 * 目的：窗口不能再被压到更小，避免卡片被挤窄、文字截断（用户反馈过的"压缩后很难看"）。
	 * 小屏保护：若显示器可用区域比这个还小，按屏幕缩放最小尺寸，防止窗口超出屏幕。
	 */
	const DESIGN_W = 1023;
	const DESIGN_H = 629;
	// 最小尺寸 = 设计尺寸：窗口不能再被压小（压小会让卡片挤窄、文字截断）
	let minW = DESIGN_W;
	let minH = DESIGN_H;
	try {
		const area = screen.getPrimaryDisplay().workAreaSize;
		if (area.width < DESIGN_W + 40 || area.height < DESIGN_H + 40) {
			// 显示器本身比设计尺寸还小 → 按屏幕等比放宽，否则窗口超出屏幕无法操作
			const k = Math.min((area.width - 40) / DESIGN_W, (area.height - 90) / DESIGN_H, 1);
			minW = Math.max(820, Math.floor(DESIGN_W * k));
			minH = Math.max(560, Math.floor(DESIGN_H * k));
			log(`屏幕可用区 ${area.width}×${area.height} 偏小，最小窗口放宽为 ${minW}×${minH}`);
		}
	} catch {
		/* 取不到屏幕信息时用设计尺寸 */
	}
	// 尽量用设计尺寸开窗；屏幕放不下就等比缩到可用区
	let winW = DESIGN_W;
	let winH = DESIGN_H;
	try {
		const area = screen.getPrimaryDisplay().workAreaSize;
		const k = Math.min(1, area.width / DESIGN_W, area.height / DESIGN_H);
		winW = Math.max(minW, Math.floor(DESIGN_W * k));
		winH = Math.max(minH, Math.floor(DESIGN_H * k));
	} catch {
		/* 保持设计尺寸 */
	}

	win = new BrowserWindow({
		width: winW,
		height: winH,
		minWidth: minW,
		minHeight: minH,
		useContentSize: true,
		backgroundColor: "#0b0d12",
		show: false,
		autoHideMenuBar: true,
		title: "432Hz Player",
		icon: existsSync(ICON) ? ICON : undefined,
		webPreferences: {
			preload: join(HERE, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			spellcheck: false,
		},
	});
	let shown = false;
	const reveal = (why) => {
		if (shown || win === null || win.isDestroyed()) return;
		shown = true;
		log("窗口显示:", why);
		win.show();
		win.focus();
		if (process.env.HZ432_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
	};
	win.once("ready-to-show", () => reveal("ready-to-show"));
	win.webContents.on("did-finish-load", () => reveal("did-finish-load"));
	win.webContents.on("did-fail-load", (_e, code, desc, url) => {
		log("加载失败:", code, desc, url);
		setTimeout(() => void win?.loadURL(BASE), 800);
	});
	// 兜底：3 秒后无论渲染状态如何都显示窗口；若窗口仍不可见，退回浏览器应用窗口保证用户能看到界面
	setTimeout(() => {
		reveal("timeout");
		setTimeout(async () => {
			if (win === null || win.isDestroyed()) return;
			if (win.isVisible()) return;
			log("Electron 窗口不可见，回退为浏览器应用窗口");
			try {
				await fetch(`${BASE}/api/open-window`, { method: "POST" });
				quitting = true;
				app.quit();
			} catch {
				/* 保持现状 */
			}
		}, 1500);
	}, 3000);

	// 外链走系统浏览器，不在应用内打开
	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});
	win.on("close", (event) => {
		if (!quitting) {
			// 关闭窗口 = 收进托盘（音频继续），同时从任务栏移除，只留托盘图标
			event.preventDefault();
			hideToTray();
			log("窗口收进托盘（音频继续，任务栏不再显示）");
		}
	});
	win.loadURL(BASE).catch((error) => log("loadURL 异常:", String(error?.message ?? error)));
}

/** 收起到托盘：隐藏窗口并从任务栏移除（只保留托盘图标）。 */
function hideToTray() {
	if (win === null || win.isDestroyed()) return;
	try {
		win.setSkipTaskbar(true);
	} catch {
		/* 某些平台不支持，忽略 */
	}
	win.hide();
}

/** 从托盘恢复：重新显示窗口并回到任务栏。 */
function restoreFromTray() {
	if (win === null || win.isDestroyed()) return;
	try {
		win.setSkipTaskbar(false);
	} catch {
		/* ignore */
	}
	win.show();
	win.focus();
}

function createTray() {
	if (!existsSync(ICON)) return;
	try {
		const image = nativeImage.createFromPath(ICON);
		tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
		tray.setToolTip("432Hz 播放器（双击图标恢复窗口）");
		const rebuild = async () => {
			let running = false;
			try {
				const res = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) });
				running = (await res.json())?.running === true;
			} catch {
				/* 服务未就绪 */
			}
			tray.setContextMenu(Menu.buildFromTemplate([
				{ label: `432Hz 播放器 — ${running ? "已接管" : "未接管"}`, enabled: false },
				{ type: "separator" },
				{ label: "打开主界面", click: () => restoreFromTray() },
				{
					label: running ? "停止接管" : "开始接管",
					click: async () => {
						try {
							await fetch(`${BASE}/api/${running ? "stop" : "start"}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
						} catch {
							/* ignore */
						}
						void rebuild();
					},
				},
				{ type: "separator" },
				{ label: "退出（并停止接管）", click: () => void quitApp() },
			]));
		};
		void rebuild();
		tray.on("click", () => restoreFromTray());
		setInterval(() => void rebuild(), 4000);
	} catch {
		/* 托盘失败不影响主功能 */
	}
}

async function quitApp() {
	quitting = true;
	try {
		await fetch(`${BASE}/api/quit`, { method: "POST", signal: AbortSignal.timeout(2500) });
	} catch {
		/* 服务可能已退出 */
	}
	try {
		server?.close?.();
	} catch {
		/* ignore */
	}
	app.quit();
}

app.whenReady().then(async () => {
	const started = await startServer();
	if (started.ok !== true) {
		dialog.showErrorBox("启动失败", `音频服务未能启动：${started.error}\n\n请确认程序目录完整（server.mjs 与 tools/ 是否在）。`);
	}
	createWindow();
	createTray();

	// 供渲染进程调用（打开数据目录等）
	ipcMain.handle("open-data-dir", async () => {
		const dir = join(app.getPath("home"), ".432hz-player");
		await shell.openPath(dir);
		return { ok: true, dir };
	});
	ipcMain.handle("quit", async () => {
		void quitApp();
		return { ok: true };
	});

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
		else { win?.show(); win?.focus(); }
	});
});

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => {
	// Windows 上关窗口不退出（托盘常驻）；只有显式退出才结束
	if (process.platform !== "win32") app.quit();
});

// 兜底：进程退出时确保引擎停掉（服务自身也有清理逻辑）
process.on("exit", () => {
	try {
		spawn("taskkill.exe", ["/IM", "AudioRender.exe", "/F"], { stdio: "ignore", windowsHide: true });
	} catch {
		/* ignore */
	}
});
