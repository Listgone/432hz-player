#!/usr/bin/env node
/**
 * 432Hz 播放器 — 独立版宿主。
 *
 * 作用：把系统里正在播放的声音转成 432Hz（A4 440 → 432，−31.77 cent，保时长）后送到物理声卡。
 *
 * 音频链路：
 *   所有 App → Windows 默认播放设备 = CABLE Input (VB-CABLE)
 *     → CABLE Output（dshow 捕获）→ ffmpeg 滤镜链（asetrate+atempo）
 *       → 原始 PCM（管道）→ AudioRender.exe（WASAPI 显式渲染）→ 物理声卡
 *
 * 为什么输出不用 ffplay：ffplay/SDL2 无设备选择参数，只能跟随系统默认设备；而
 * Windows 11 24H2+ 切换默认设备的未公开接口已失效（IPolicyConfig 新旧 CLSID/IID 均为空实现，
 * WinRT AudioPolicyConfig vtable 不兼容）。AudioRender.exe 按端点 ID 直接打开 WASAPI 渲染流，
 * 与系统默认设备解耦，因此系统默认可以一直保持 CABLE Input（所有 App 都被捕获），
 * 从结构上消除「输出被自己再抓一遍」的自激环。
 *
 * 本文件不依赖 DSH：只依赖 Node 内置模块 + 同目录 tools/ 下的两个 exe。
 */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, createReadStream, createWriteStream, openSync, closeSync, readSync, fstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** server.mjs 就在项目根目录，因此 HERE 即应用根。 */
const APP_DIR = HERE;
/**
 * 工具目录解析：三种运行形态
 *   1. Electron 打包（app.asar 内）：可执行文件不能从 asar 里 spawn →
 *      用 extraResources 释放出来的 `resources/tools`。
 *   2. 单文件 exe：与 exe 同级的 tools/。
 *   3. 源码直接跑：项目根 tools/。
 */
const PACKAGED_RESOURCES = typeof process.resourcesPath === "string" && process.resourcesPath !== "" ? process.resourcesPath : null;
const TOOLS_DIR = PACKAGED_RESOURCES !== null && existsSync(join(PACKAGED_RESOURCES, "tools", "AudioRender.exe"))
	? join(PACKAGED_RESOURCES, "tools")
	: join(APP_DIR, "tools");

/** SEA 单文件模式：入口代码已内联，磁盘上没有 server.mjs / web/，UI 由构建期内联。 */
let SINGLE_FILE = false;
let EMBEDDED_HTML = null;
try {
	// 构建时由 scripts/build-exe.mjs 注入：const EMBEDDED_HTML = "...";
	if (typeof globalThis.__HZ432_HTML__ === "string") {
		SINGLE_FILE = true;
		EMBEDDED_HTML = globalThis.__HZ432_HTML__;
	}
} catch {
	/* ignore */
}
/** 界面目录：web/index.html 可从 asar 内直接读取，无需额外处理。 */
const WEB_DIR = join(APP_DIR, "web");
const ENDPOINT_EXE = join(TOOLS_DIR, "AudioEndpoint.exe");
const RENDER_EXE = join(TOOLS_DIR, "AudioRender.exe");
const DATA_DIR = join(homedir(), ".432hz-player");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const LOG_FILE = join(DATA_DIR, "engine.log");
/** 软件自身日志（log() 写入），与 ffmpeg/AudioRender 的 engine.log 分开，带 2MB 轮转。 */
const APP_LOG_FILE = join(DATA_DIR, "app.log");
const APP_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** 日志接口单次最多读取的文件字节数，避免超大日志把请求拖慢。 */
const LOG_READ_BYTES = 1024 * 1024;
/** 内存环形缓冲容量（/api/logs 的实时来源）。 */
const MEM_LOG_LIMIT = 1000;

const PORT = Number(process.env.HZ432_PORT ?? 4399);
const REF_HZ = 440;
const TARGET_HZ = 432;
const PITCH_RATIO = TARGET_HZ / REF_HZ;

const FF_CANDIDATES = [
	"D:\\ffmpeg-8.1.1-essentials_build\\bin",
	"C:\\ffmpeg\\bin",
	"D:\\ffmpeg\\bin",
	join(homedir(), "scoop", "shims"),
];
const CABLE_HINTS = ["cable output", "cable input", "vb-audio", "vbcable", "virtual cable"];

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
/**
 * 内存环形缓冲：软件日志的实时来源（/api/logs 优先用它，避免频繁读盘）。
 * 每行都带 `[ISO时间] ` 前缀，便于与 app.log / engine.log 的行合并后按时间排序。
 */
const memLogs = [];
function pushMemLog(line) {
	memLogs.push(line);
	if (memLogs.length > MEM_LOG_LIMIT) memLogs.splice(0, memLogs.length - MEM_LOG_LIMIT);
}

/** 从 `[ISO时间] 内容` 行里取时间戳；取不到返回 null。 */
function logLineTime(line) {
	const match = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/.exec(String(line));
	if (match === null) return null;
	const ms = Date.parse(match[1]);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * 写一行到软件日志：控制台 + 内存环形缓冲 + `%USERPROFILE%\.432hz-player\app.log`。
 * 轮转：app.log 超过 2MB 时重命名为 app.log.1（覆盖上一份备份）。
 * Windows GUI 子系统下没有控制台，console.log 可能抛 EPIPE，因此全程 try/catch，日志失败绝不影响功能。
 */
const log = (...parts) => {
	const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
	try {
		console.log(line);
	} catch {
		/* GUI 子系统无控制台 / 管道已断开 */
	}
	try {
		pushMemLog(line);
	} catch {
		/* ignore */
	}
	try {
		mkdirSync(DATA_DIR, { recursive: true });
		try {
			if (existsSync(APP_LOG_FILE) && statSync(APP_LOG_FILE).size > APP_LOG_MAX_BYTES) {
				renameSync(APP_LOG_FILE, `${APP_LOG_FILE}.1`);
			}
		} catch {
			/* 轮转失败就继续追加，不阻断 */
		}
		writeFileSync(APP_LOG_FILE, `${line}\n`, { flag: "a" });
	} catch {
		/* 日志失败不影响功能 */
	}
};

/** 读文件尾部的解码文本（最多 maxBytes 字节）。文件不存在/读失败返回 null。 */
function readFileTailText(file, maxBytes) {
	let fd = null;
	try {
		if (!existsSync(file)) return null;
		fd = openSync(file, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		if (length <= 0) return "";
		const buffer = Buffer.allocUnsafe(length);
		let read = 0;
		while (read < length) {
			const n = readSync(fd, buffer, read, length - read, start + read);
			if (n <= 0) break;
			read += n;
		}
		return buffer.subarray(0, read).toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * 最近 N 行日志：内存环形缓冲 + app.log + engine.log 合并去重，按时间排序（无时间戳的行排在前面）。
 * 任一来源读取失败就自动跳过；engine.log 失败时仍返回内存部分。
 */
function collectLogLines(limit) {
	const seen = new Set();
	const rows = [];
	for (const line of memLogs) {
		const key = line.trim();
		if (key === "" || seen.has(key)) continue;
		seen.add(key);
		rows.push({ line, at: logLineTime(line), seq: rows.length });
	}
	for (const file of [APP_LOG_FILE, LOG_FILE]) {
		const text = readFileTailText(file, LOG_READ_BYTES);
		if (text === null) continue;
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trimEnd();
			const key = line.trim();
			if (key === "" || seen.has(key)) continue;
			seen.add(key);
			rows.push({ line, at: logLineTime(line), seq: rows.length });
		}
	}
	rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.seq - b.seq);
	return rows.slice(-limit).map((row) => row.line);
}

/** 软件版本：开发模式从 package.json 读；单文件模式用构建期内联的 globalThis.__HZ432_VERSION__。 */
function appVersion() {
	try {
		if (typeof globalThis.__HZ432_VERSION__ === "string" && globalThis.__HZ432_VERSION__ !== "") return globalThis.__HZ432_VERSION__;
	} catch {
		/* ignore */
	}
	const pkg = readJson(join(APP_DIR, "package.json"), null);
	return typeof pkg?.version === "string" ? pkg.version : "未知";
}

/** /api/export-log 的正文：版本 + 时间 + 依赖探测 + 配置 + 最近 1000 行日志。 */
function buildLogExport() {
	const dep = deps ?? {};
	const lines = [
		"432Hz 播放器 — 日志导出",
		"========================================",
		`软件版本   : ${appVersion()}`,
		`导出时间   : ${new Date().toISOString()}（本地 ${new Date().toLocaleString()}）`,
		`运行模式   : ${SINGLE_FILE ? "单文件 exe（SEA）" : "node server.mjs（开发）"}`,
		`程序目录   : ${APP_DIR}`,
		`数据目录   : ${DATA_DIR}`,
		`服务地址   : http://127.0.0.1:${PORT}`,
		`引擎状态   : ${runtime.phase}${runtime.producer !== null ? "（运行中）" : ""}`,
		`Node 版本  : ${process.version} / 平台 ${process.platform} ${process.arch}`,
		"",
		"-- 依赖探测 --",
		`ffmpeg           : ${dep.ffmpeg ?? "未找到（需装在 PATH 或 FF_CANDIDATES 目录）"}`,
		`ffmpeg dshow     : ${dep.hasDshow === true ? "支持" : "不支持/未知"}`,
		`端点工具         : ${dep.endpointTool === true ? ENDPOINT_EXE : `缺失（${ENDPOINT_EXE}）`}`,
		`render 工具      : ${dep.renderTool === true ? RENDER_EXE : `缺失（${RENDER_EXE}）`}`,
		`VB-CABLE 已安装  : ${dep.vcable?.installed === true ? "是" : "否"}`,
		`  CABLE Input   : ${dep.vcable?.renderName ?? "-"} ${dep.vcable?.renderId ?? ""}`.trimEnd(),
		`  CABLE Output  : ${dep.vcable?.captureName ?? "-"} ${dep.vcable?.captureId ?? ""}`.trimEnd(),
		`系统默认播放设备 : ${dep.defaultRender?.name ?? "-"} ${dep.defaultRender?.id ?? ""}`.trimEnd(),
		`物理输出设备     : ${physicalRender(dep).length} 个可用（state=active 且非 CABLE；共枚举到 ${Array.isArray(dep.render) ? dep.render.length : 0} 个端点）`,
		`当前输出设备可用 : ${outputDeviceAvailable() ? "是" : "否（设备可能已拔出/断开）"}`,
		...renderNameLines(dep.render),
		`设备列表刷新     : ${deviceListState()}`,
		"",
		"-- 配置 JSON --",
		JSON.stringify({ config }, null, 2),
		"",
		"-- 最近 1000 行日志（内存 + app.log + engine.log 合并）--",
		...collectLogLines(1000),
		"",
	];
	return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// 日志接口辅助
// ---------------------------------------------------------------------------
const clamp = (value, min, max) => {
	const n = Number(value);
	if (!Number.isFinite(n)) return min;
	return n < min ? min : n > max ? max : n;
};
/** 虚拟声卡识别：名字**或**适配器名命中关键字即算虚拟设备（防止改名/多语言漏判）。 */
const looksLikeCable = (text) => {
	const lower = String(text ?? "").toLowerCase();
	return CABLE_HINTS.some((hint) => lower.includes(hint));
};
/** 端点是否为虚拟声卡（同时看 name 与 adapter，例如 VB-CABLE A+B 的 "CABLE In 16ch"）。 */
const isVirtualEndpoint = (endpoint) => looksLikeCable(endpoint?.name) || looksLikeCable(endpoint?.adapter);
const readJson = (path, fallback = null) => {
	try {
		return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
	} catch {
		return fallback;
	}
};
const writeJson = (path, value) => {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
		renameSync(tmp, path);
		return true;
	} catch (error) {
		log("config write failed:", String(error?.message ?? error));
		return false;
	}
};

/** 同步执行外部命令，永不带管道回调外的副作用；失败返回 {code:-1}。 */
function runSync(file, args, timeout = 15000) {
	return new Promise((resolveRun) => {
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (code) => {
			if (done) return;
			done = true;
			resolveRun({ code, stdout, stderr });
		};
		try {
			const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			const timer = setTimeout(() => {
				try {
					child.kill();
				} catch {
					/* ignore */
				}
				finish(-1);
			}, timeout);
			child.stdout.on("data", (buffer) => {
				stdout += buffer.toString("utf8");
			});
			child.stderr.on("data", (buffer) => {
				stderr += buffer.toString("utf8");
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				stderr += String(error.message);
				finish(-1);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				finish(code ?? -1);
			});
		} catch (error) {
			stderr += String(error?.message ?? error);
			finish(-1);
		}
	});
}

/** 跑外部命令并把最后一行 JSON 解析出来。 */
async function runJson(file, args, timeout = 15000) {
	const out = await runSync(file, args, timeout);
	const text = `${out.stdout}\n${out.stderr}`.trim();
	const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index].trim();
		if (!line.startsWith("{")) continue;
		try {
			return JSON.parse(line);
		} catch {
			/* 继续向前找 */
		}
	}
	return { ok: false, error: out.stderr.slice(-300) || "no JSON output", code: out.code };
}

function resolveExe(basename) {
	for (const dir of FF_CANDIDATES) {
		const candidate = join(dir, `${basename}.exe`);
		if (existsSync(candidate)) return candidate;
	}
	try {
		// PATH 兜底：where.exe 是 Windows 自带的
		const found = execFileSync("where.exe", [basename], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
		if (found && existsSync(found)) return found;
	} catch {
		/* 忽略 */
	}
	return null;
}

// ---------------------------------------------------------------------------
// 依赖探测
// ---------------------------------------------------------------------------
/** 设备列表刷新 TTL（毫秒）：蓝牙耳机等热插拔设备最多 3 秒后出现在列表里。 */
const DEVICES_TTL_MS = 3000;
/** 上次成功枚举设备列表的时间戳（0 = 还没探测过）。 */
let devicesAt = 0;
/** 刷新互斥：并发请求不会重复枚举端点。 */
let devicesRefreshing = false;

/** 从一次端点枚举结果里挑出 VB-CABLE 与系统默认播放设备。 */
function pickFromDevices(render, capture, defaultRender) {
	const cableRender = render.find((item) => item.state === "active" && isVirtualEndpoint(item));
	const cableCapture = capture.find((item) => item.state === "active" && isVirtualEndpoint(item));
	return {
		vcable: {
			installed: cableRender !== undefined && cableCapture !== undefined,
			renderName: cableRender?.name ?? null,
			renderId: cableRender?.id ?? null,
			captureName: cableCapture?.name ?? null,
			captureId: cableCapture?.id ?? null,
		},
		defaultRender: defaultRender ?? null,
	};
}

/**
 * 轻量端点枚举：只跑 AudioEndpoint.exe list + default（约 200-400ms），不跑 ffmpeg 探测。
 * 供 status() 的 3 秒 TTL 刷新使用。
 * @param current - 当前 deps（作为失败回退，避免一次枚举失败就把设备列表清空）。
 */
async function enumerateDevices(current = null) {
	const render = Array.isArray(current?.render) ? current.render : [];
	const capture = Array.isArray(current?.capture) ? current.capture : [];
	const fallbackDefault = current?.defaultRender ?? null;
	const endpointTool = existsSync(ENDPOINT_EXE);
	if (!endpointTool) {
		return { render, capture, defaultRender: fallbackDefault, endpointTool: false };
	}
	let nextRender = null;
	let nextCapture = null;
	let defaultRender = null;
	try {
		const list = await runJson(ENDPOINT_EXE, ["list"], 20000);
		if (list?.ok === true) {
			nextRender = Array.isArray(list.render) ? list.render : [];
			nextCapture = Array.isArray(list.capture) ? list.capture : [];
		}
	} catch {
		/* 枚举失败保留旧列表 */
	}
	try {
		const def = await runJson(ENDPOINT_EXE, ["default"], 12000);
		if (def?.ok === true) defaultRender = def.render ?? null;
	} catch {
		/* 默认设备查询失败保留旧值 */
	}
	return {
		render: nextRender ?? render,
		capture: nextCapture ?? capture,
		defaultRender: defaultRender ?? fallbackDefault,
		endpointTool: true,
	};
}

/**
 * 设备列表定期刷新：超过 TTL_MS 就重新枚举端点并就地刷新 deps.render / deps.capture /
 * deps.vcable / deps.defaultRender。并发调用只跑一次枚举，单个请求不会被拖住多次枚举。
 * @returns 本次是否真的枚举了。
 */
async function refreshDevicesIfStale() {
	const now = Date.now();
	if (deps !== null && now - devicesAt < DEVICES_TTL_MS) return false;
	if (devicesRefreshing) return false;
	devicesRefreshing = true;
	let ok = false;
	try {
		const next = await enumerateDevices(deps);
		devicesAt = Date.now();
		if (deps === null) deps = await detect();
		else {
			deps.render = next.render;
			deps.capture = next.capture;
			const picked = pickFromDevices(next.render, next.capture, next.defaultRender);
			deps.vcable = picked.vcable;
			deps.defaultRender = picked.defaultRender;
			deps.endpointTool = next.endpointTool;
		}
		ok = true;
	} catch {
		/* 刷新失败不影响已有 deps */
	} finally {
		devicesRefreshing = false;
	}
	return ok;
}

/** 设备枚举状态（导出到 /api/status 与日志里，供界面/排障判断列表是否新鲜）。 */
function deviceListState() {
	const age = devicesAt === 0 ? -1 : Date.now() - devicesAt;
	return { ttlMs: DEVICES_TTL_MS, lastEnumMs: age, refreshing: devicesRefreshing };
}

/** 界面/日志共用的物理输出设备过滤：state==='active' 且非 CABLE。 */
function physicalRender(source = deps) {
	const render = Array.isArray(source?.render) ? source.render : [];
	return render.filter((item) => item.state === "active" && !isVirtualEndpoint(item));
}

/** 导出日志里列出物理输出设备名。 */
function renderNameLines(render) {
	if (!Array.isArray(render) || render.length === 0) return ["  （无）"];
	return render.map((item) => `  - ${item?.name ?? "?"} [${item?.state ?? "?"}] ${item?.id ?? ""}`.trimEnd());
}

/**
 * 兜底挑物理输出设备：优先当前系统默认（非 CABLE 时才认），否则取列表第一个可用物理设备。
 * 场景：软件接管后系统默认会变成 CABLE Input，此时「默认设备」不能再当输出，用户全新配置时会没得选。
 */
function pickPhysicalOutput() {
	const physical = physicalRender();
	const def = deps?.defaultRender ?? null;
	if (def !== null && !isVirtualEndpoint(def)) {
		const exact = physical.find((item) => item.id === def.id);
		if (exact !== undefined) return exact;
	}
	return physical[0] ?? null;
}
async function detect() {
	const result = {
		ffmpeg: resolveExe("ffmpeg"),
		endpointTool: existsSync(ENDPOINT_EXE),
		renderTool: existsSync(RENDER_EXE),
		vcable: { installed: false, renderName: null, renderId: null, captureName: null, captureId: null },
		render: [],
		capture: [],
		defaultRender: null,
	};
	if (result.endpointTool) {
		const dev = await enumerateDevices(null);
		result.render = dev.render;
		result.capture = dev.capture;
		result.defaultRender = dev.defaultRender;
		const picked = pickFromDevices(result.render, result.capture, result.defaultRender);
		result.vcable = picked.vcable;
		// 记下枚举时间：status() 的 3 秒 TTL 从这次成功枚举开始算
		devicesAt = Date.now();
	}
	if (result.ffmpeg !== null) {
		const dev = await runSync(result.ffmpeg, ["-hide_banner", "-devices"], 10000);
		result.hasDshow = /dshow/i.test(`${dev.stdout}${dev.stderr}`);
	} else {
		result.hasDshow = false;
	}
	return result;
}

// ---------------------------------------------------------------------------
// 滤镜链
// ---------------------------------------------------------------------------
/**
 * 432Hz 滤镜链。asetrate 改采样率声明 → 音高 ×ratio、时长 ÷ratio；atempo 用 1/ratio 还原时长。
 * @param options - 采样率 / 目标音高 / 增益 / 干湿 / 限幅 / 高质量档。
 * @returns ffmpeg -af 参数字符串。
 */
export function buildFilterChain(options = {}) {
	const rate = Number(options.rate) || 48000;
	const target = clamp(options.targetHz ?? TARGET_HZ, 415, 445);
	const ratio = target / REF_HZ;
	const gainDb = clamp(options.gainDb ?? 0, -12, 12);
	const mix = clamp(options.mix ?? 1, 0, 1);
	const limiter = options.limiter !== false;
	const highQuality = options.highQuality === true;
	const bypass = options.bypass === true || ratio === 1;
	const chain = [`aresample=${rate}`];
	if (!bypass) {
		if (highQuality) {
			// rubberband 相位声码器；window=long 是实测量准值（默认 short 窗偏 +3.87 cent）。
			chain.push(`rubberband=pitch=${ratio.toFixed(8)}:window=long:pitchq=quality`);
		} else {
			chain.push(`asetrate=${rate}*${ratio.toFixed(8)}`);
			chain.push(`aresample=${rate}`);
			chain.push(`atempo=${(1 / ratio).toFixed(8)}`);
		}
	}
	if (mix > 0 && mix < 1 && !bypass) {
		chain.push("asplit=2[dry][wetsrc]");
		chain.push(`[wetsrc]volume=${gainDb.toFixed(2)}dB[wet]`);
		chain.push(`[dry][wet]amix=inputs=2:weights=${(1 - mix).toFixed(4)} ${mix.toFixed(4)}:normalize=0`);
	} else if (gainDb !== 0) {
		chain.push(`volume=${gainDb.toFixed(2)}dB`);
	}
	if (limiter) chain.push("alimiter=limit=0.97:attack=5:release=50");
	return chain.join(",");
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
const defaults = {
	targetHz: TARGET_HZ,
	gainDb: 0,
	mix: 1,
	limiter: true,
	highQuality: false,
	bufferMs: 200,
	outputDeviceId: null,
	outputDeviceName: null,
	captureDeviceName: null,
	/** 启动软件后自动开始接管 */
	autoStart: true,
	/** 启动时把系统默认播放设备设为 CABLE Input（让所有 App 被捕获） */
	forceCableDefault: true,
	/** 开机自启（界面上的开关，落盘用于回显） */
	launchAtLogin: false,
	/** 接管前的系统默认播放设备快照（落盘，供崩溃后自愈与停止还原） */
	defaultDeviceSnapshot: null,
};
const saved = readJson(CONFIG_FILE, {}) ?? {};
const config = { ...defaults, ...(saved.config ?? {}) };
const saveConfig = () => writeJson(CONFIG_FILE, { config });

let deps = null;
const runtime = {
	phase: "idle",
	producer: null,
	renderer: null,
	startedAt: 0,
	logs: [],
	lastError: null,
	rendererInfo: null,
	levels: null,
	format: null,
	generation: 0,
	restarting: false,
	/**
	 * 接管**之前**的系统默认播放设备（有它才能在停止时还原，否则用户会「没声音」）。
	 * 结构：{ renderId, renderName, at }
	 */
	defaultSnapshot: null,
	/** 最近一次停止时的还原结果（UI 展示 + 排障）。 */
	lastRestore: null,
};

// 载入上次落盘的快照：程序崩溃/被强杀时，下次启动就能把默认设备换回去。
if (config.defaultDeviceSnapshot !== null && config.defaultDeviceSnapshot !== undefined) {
	runtime.defaultSnapshot = config.defaultDeviceSnapshot;
}

function pushLog(chunk) {
	const text = String(chunk).replace(/\r/g, "\n");
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		if (line.trim() === "") continue;
		runtime.logs.push(line);
		if (runtime.logs.length > 400) runtime.logs.splice(0, runtime.logs.length - 400);
	}
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------
async function startEngine(reason = "manual") {
	if (runtime.phase === "running" || runtime.phase === "starting") {
		return { ok: false, error: "已在运行" };
	}
	if (deps === null) deps = await detect();
	runtime.lastError = null;

	if (!deps.renderTool) return { ok: false, error: "缺少 tools/AudioRender.exe（请先运行构建脚本）", dependency: true };
	if (deps.ffmpeg === null) return { ok: false, error: "未找到 ffmpeg.exe（请安装并加入 PATH）", dependency: true };
	if (!deps.vcable.installed) {
		return { ok: false, error: "未检测到 VB-CABLE（需同时存在 CABLE Input 与 CABLE Output，装完要重启）", dependency: true };
	}
	const outId = config.outputDeviceId;
	if (outId === null || outId === undefined) return { ok: false, error: "未选择输出设备（物理扬声器/耳机）" };
	const endpoint = deps.render.find((item) => item.id === outId);
	if (endpoint === undefined) {
		return { ok: false, error: `输出设备不可用：${config.outputDeviceName ?? outId}（可能已拔出）` };
	}
	if (isVirtualEndpoint(endpoint)) {
		return { ok: false, error: `输出设备指向虚拟声卡（${endpoint.name}）：会造成自激啸叫，已拒绝启动` };
	}

	// 让系统默认播放设备指向 CABLE Input：所有 App 的声音才都会被捕获。
	// 关键：切换前必须记下「原本的默认设备」，否则停止接管后系统默认仍指向虚拟声卡
	// → 用户会觉得「没声音了」（声音被送进 CABLE 却没人处理后段）。
	let routed = { ok: true, detail: "默认设备已是 CABLE Input" };
	if (config.forceCableDefault === true && deps.vcable.renderId !== null) {
		const current = await runJson(ENDPOINT_EXE, ["default"], 12000);
		const currentId = current?.ok === true ? current.render?.id ?? null : null;
		if (currentId !== null && currentId !== deps.vcable.renderId) {
			// 记快照（含名字，便于 UI/日志展示），并落盘，供崩溃后下次启动自愈
			runtime.defaultSnapshot = {
				renderId: currentId,
				renderName: current.render?.name ?? null,
				at: Date.now(),
			};
			config.defaultDeviceSnapshot = runtime.defaultSnapshot;
			saveConfig();
			log(`记录原默认播放设备：${runtime.defaultSnapshot.renderName ?? currentId}`);
			const sw = await runJson(ENDPOINT_EXE, ["set-render", deps.vcable.renderId], 20000);
			routed = sw.ok === true
				? { ok: true, detail: "已把系统默认播放设备切到 CABLE Input" }
				: { ok: false, detail: `默认设备切换失败（${sw.error ?? "unknown"}）；请在系统声音设置里手动把默认播放设备设为 CABLE Input` };
		} else {
			// 默认已经是 CABLE：可能是用户自己设的，也可能是上次异常退出没还原。
			// 这时没有「切换前快照」，用落盘的旧快照 / 用户指定的物理输出设备兜底，
			// 保证停止时一定能还回去（否则用户会一直没声音）。
			const fallback = runtime.defaultSnapshot ?? config.defaultDeviceSnapshot ?? (outId !== null ? { renderId: outId, renderName: config.outputDeviceName, at: Date.now() } : null);
			if (fallback !== null && fallback.renderId !== deps.vcable.renderId) {
				runtime.defaultSnapshot = fallback;
				routed = { ok: true, detail: `默认设备已是 CABLE Input；已准备还原目标「${fallback.renderName ?? fallback.renderId}」` };
			} else {
				routed = { ok: true, detail: "默认设备已是 CABLE Input（未找到还原目标，停止后将回退到已选输出设备）" };
			}
		}
	}

	const captureName = config.captureDeviceName ?? deps.vcable.captureName;
	const rate = 48000;
	const chain = buildFilterChain({
		rate,
		targetHz: config.targetHz,
		gainDb: config.gainDb,
		mix: config.mix,
		limiter: config.limiter,
		highQuality: config.highQuality,
	});
	const ffArgs = [
		"-hide_banner", "-loglevel", "info",
		"-f", "dshow", "-audio_buffer_size", String(Math.max(50, Number(config.bufferMs) || 200)), "-i", `audio=${captureName}`,
		"-af", chain,
		"-f", "s16le", "-acodec", "pcm_s16le", "-ar", String(rate), "-ac", "2",
		"-",
	];
	const renderArgs = ["--device", outId, "--rate", String(rate), "--channels", "2", "--format", "s16", "--stats-ms", "500"];

	runtime.phase = "starting";
	runtime.logs = [];
	const generation = ++runtime.generation;
	pushLog(`start(${reason}) capture="${captureName}" output="${endpoint.name}"`);
	pushLog(`filter: ${chain}`);

	let renderer;
	try {
		renderer = spawn(RENDER_EXE, renderArgs, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	} catch (error) {
		runtime.phase = "error";
		runtime.lastError = `输出组件启动失败：${String(error?.message ?? error)}`;
		return { ok: false, error: runtime.lastError };
	}
	let producer;
	try {
		producer = spawn(deps.ffmpeg, ffArgs, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		try {
			renderer.kill();
		} catch {
			/* ignore */
		}
		runtime.phase = "error";
		runtime.lastError = `ffmpeg 启动失败：${String(error?.message ?? error)}`;
		return { ok: false, error: runtime.lastError };
	}
	producer.stdout.pipe(renderer.stdin);
	producer.stdout.on("error", () => {});
	renderer.stdin.on("error", () => {});

	runtime.producer = producer;
	runtime.renderer = renderer;
	runtime.startedAt = Date.now();
	runtime.phase = "running";
	runtime.rendererInfo = null;
	runtime.levels = null;
	runtime.format = { rate, layout: "stereo" };

	let buffer = "";
	renderer.stderr.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line !== "") {
				try {
					const parsed = JSON.parse(line);
					if (parsed.ready === true) {
						runtime.rendererInfo = parsed;
						pushLog(`render ready: ${parsed.deviceRate}Hz/${parsed.deviceChannels}ch/${parsed.deviceFormat}`);
					} else if (parsed.evt === "level") {
						const now = Date.now();
						const prev = runtime.levels;
						// 用「本次与上次的帧差 / 时间差」推算渲染端真实消费速率，与设备时钟对照
						let rate = prev?.at !== undefined && now > prev.at ? ((parsed.frames - prev.frames) * 1000) / (now - prev.at) : null;
						if (rate !== null && (!Number.isFinite(rate) || rate < 8000 || rate > 200000)) rate = null;
						runtime.levels = { rmsDb: parsed.rmsDb, peak: parsed.peak, frames: parsed.frames, at: now, consumeRate: rate };
					} else if (parsed.ok === false) {
						runtime.lastError = `输出组件错误：${parsed.step ?? ""} ${parsed.hr ?? parsed.error ?? ""}`.trim();
						pushLog(runtime.lastError);
					}
				} catch {
					pushLog(`[render] ${line}`);
				}
			}
			index = buffer.indexOf("\n");
		}
	});
	producer.stderr.on("data", (chunk) => pushLog(chunk.toString("utf8")));

	const onExit = (who) => (code) => {
		pushLog(`${who} exit code=${code}`);
		if (runtime.generation !== generation) return;
		if (runtime.restarting === true || runtime.phase === "stopping") return;
		const detail = runtime.lastError ?? `${who} 异常退出（code=${code}）`;
		void stopEngine("异常退出").then(() => {
			runtime.lastError = detail;
		});
	};
	producer.on("exit", onExit("ffmpeg"));
	renderer.on("exit", onExit("render"));

	saveConfig();
	return { ok: true, chain, rate, capture: captureName, output: endpoint.name, renderer: renderArgs, routed };
}

async function stopEngine(reason = "manual") {
	runtime.phase = "stopping";
	runtime.generation += 1;
	const producer = runtime.producer;
	const renderer = runtime.renderer;
	runtime.producer = null;
	runtime.renderer = null;
	try {
		producer?.stdout?.unpipe?.(renderer?.stdin);
	} catch {
		/* ignore */
	}
	try {
		producer?.kill();
	} catch {
		/* ignore */
	}
	try {
		renderer?.stdin?.end();
	} catch {
		/* ignore */
	}
	await new Promise((r) => setTimeout(r, 500));
	for (const child of [producer, renderer]) {
		if (child === null || child === undefined || child.exitCode !== null) continue;
		await runSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], 8000);
	}
	runtime.startedAt = 0;

	// ── 还原系统默认播放设备 ────────────────────────────────────────────────
	// 不还原的话：默认设备仍指向 CABLE Input，声音进了虚拟声卡却没人接后段 →
	// 用户表现为「取消接管后没声音」。所以这里必须把接管前的设备换回去。
	const restore = await restoreDefaultDevice(reason);
	runtime.lastRestore = restore;
	runtime.phase = "idle";
	pushLog(`stopped(${reason}) 默认设备还原：${restore.ok ? "成功" : `失败(${restore.error ?? "?"})`}`);
	return { ok: true, stopped: true, restore };
}

/**
 * 把系统默认播放设备还原成接管前的那个（若当前还指向 CABLE 且存在快照）。
 * @param reason 还原触发原因，仅用于日志与 UI 展示。
 * @returns {Promise<{ok:boolean, restored?:boolean, to?:string|null, error?:string, reason:string}>}
 */
async function restoreDefaultDevice(reason = "") {
	const snap = runtime.defaultSnapshot ?? config.defaultDeviceSnapshot ?? null;
	try {
		const current = await runJson(ENDPOINT_EXE, ["default"], 12000);
		const currentId = current?.ok === true ? current.render?.id ?? null : null;
		const cableId = deps?.vcable?.renderId ?? null;

		// 已经是物理设备：无需动作
		if (currentId !== null && cableId !== null && currentId !== cableId) {
			return { ok: true, restored: false, to: currentId, reason };
		}
		// 还原目标优先级：切换前快照 → 用户已选的物理输出设备
		let targetId = snap?.renderId ?? null;
		let targetName = snap?.renderName ?? null;
		if (targetId === null && config.outputDeviceId !== null && config.outputDeviceId !== cableId) {
			targetId = config.outputDeviceId;
			targetName = config.outputDeviceName;
		}
		// 内存校验：目标设备若已永久移除（蓝牙配对删掉、声卡拔了），改用当前可用的物理设备
		const physical = (deps?.render ?? []).filter((item) => !isVirtualEndpoint(item));
		if (targetId !== null && !(deps?.render ?? []).some((item) => item.id === targetId)) {
			const fallback = physical[0] ?? null;
			if (fallback === null) {
				return {
					ok: false, restored: false, to: null,
					error: `原设备已不可用（${targetName ?? targetId}），且当前没有其它可用物理播放设备`,
					manualRequired: true,
					manualHint: "请在「设置 → 系统 → 声音」里选择一个输出设备",
					reason,
				};
			}
			log(`还原目标「${targetName ?? targetId}」已不可用，改用「${fallback.name}」`);
			targetId = fallback.id;
			targetName = fallback.name;
		}
		if (targetId === null) {
			return {
				ok: false,
				restored: false,
				to: null,
				error: "没有可还原的设备：请在「设备」页选择一个物理播放设备后重试",
				manualRequired: true,
				manualHint: "请在「设置 → 系统 → 声音」里手动选择你的扬声器或耳机",
				reason,
			};
		}
		const sw = await runJson(ENDPOINT_EXE, ["restore", targetId, "null"], 20000);
		const after = await runJson(ENDPOINT_EXE, ["default"], 12000);
		const afterId = after?.ok === true ? after.render?.id ?? null : null;
		const ok = sw.ok === true && afterId === targetId;
		if (ok) {
			runtime.defaultSnapshot = null;
			if (config.defaultDeviceSnapshot !== undefined) {
				config.defaultDeviceSnapshot = null;
				saveConfig();
			}
		}
		return {
			ok,
			restored: ok,
			to: targetName ?? targetId,
			error: ok ? undefined : (sw.error ?? `接口切换无效（可能被其它程序或系统策略改回）`),
			/** 是否需要用「手动接管」降级路径（本机 24H2+ 上切换接口可能失效） */
			manualRequired: !ok,
			manualHint: ok ? undefined : `请在「设置 → 系统 → 声音」里把默认输出设备改回「${targetName ?? targetId}」`,
			reason,
		};
	} catch (error) {
		return { ok: false, restored: false, to: snap?.renderName ?? null, error: String(error?.message ?? error), reason };
	}
}

// ---------------------------------------------------------------------------
// 自检：合成 440Hz 走同一滤镜链，再用 Goertzel 扫主频（数值验收）
// ---------------------------------------------------------------------------
function measureWav(path, lo = 400, hi = 460) {
	const buffer = readFileSync(path);
	let offset = 12;
	let fmt = null;
	let dataOffset = -1;
	let dataLength = 0;
	while (offset + 8 <= buffer.length) {
		const id = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt ") fmt = { channels: buffer.readUInt16LE(body + 2), rate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) };
		else if (id === "data") {
			dataOffset = body;
			dataLength = size;
		}
		offset = body + size + (size & 1);
	}
	if (fmt === null || dataOffset < 0) throw new Error("bad wav");
	const frames = Math.floor(dataLength / (fmt.channels * 2));
	const window = Math.min(frames, fmt.rate * 2);
	const start = Math.max(0, Math.floor((frames - window) / 2));
	const samples = new Float64Array(window);
	for (let i = 0; i < window; i += 1) {
		let acc = 0;
		for (let c = 0; c < fmt.channels; c += 1) acc += buffer.readInt16LE(dataOffset + ((i + start) * fmt.channels + c) * 2);
		samples[i] = acc / fmt.channels / 32768;
	}
	const goertzel = (freq) => {
		const w = (2 * Math.PI * freq) / fmt.rate;
		const c = 2 * Math.cos(w);
		let s1 = 0;
		let s2 = 0;
		for (let i = 0; i < window; i += 1) {
			const s0 = samples[i] + c * s1 - s2;
			s2 = s1;
			s1 = s0;
		}
		return Math.sqrt(Math.abs(s1 * s1 + s2 * s2 - c * s1 * s2)) / window;
	};
	let best = lo;
	let bestEnergy = -1;
	for (let f = lo; f <= hi; f += 0.05) {
		const energy = goertzel(f);
		if (energy > bestEnergy) {
			bestEnergy = energy;
			best = f;
		}
	}
	const e1 = goertzel(best - 0.05);
	const e3 = goertzel(best + 0.05);
	const denom = e1 - 2 * bestEnergy + e3;
	const delta = denom !== 0 ? (0.5 * (e1 - e3)) / denom : 0;
	return { hz: Number((best + delta * 0.05).toFixed(3)), seconds: Number((frames / fmt.rate).toFixed(6)) };
}

async function selfTest() {
	if (deps === null) deps = await detect();
	if (deps.ffmpeg === null) return { ok: false, error: "ffmpeg 不可用" };
	mkdirSync(DATA_DIR, { recursive: true });
	const ref = join(DATA_DIR, "selftest-ref.wav");
	const out = join(DATA_DIR, "selftest-out.wav");
	const rate = 48000;
	const chain = buildFilterChain({ rate, targetHz: config.targetHz, gainDb: 0, mix: 1, limiter: false, highQuality: config.highQuality });
	const gen = await runSync(deps.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${rate}:duration=6`, "-ac", "2", ref], 40000);
	if (gen.code !== 0) return { ok: false, error: `生成参考音失败：${gen.stderr.slice(-200)}` };
	const conv = await runSync(deps.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", ref, "-af", chain, out], 40000);
	if (conv.code !== 0) return { ok: false, error: `滤镜链执行失败：${conv.stderr.slice(-200)}` };
	const measured = measureWav(out);
	const cents = 1200 * Math.log2(measured.hz / Number(config.targetHz));
	return {
		ok: true,
		chain,
		expectedHz: Number(config.targetHz),
		measuredHz: measured.hz,
		centsOff: Number(cents.toFixed(3)),
		durationDeltaPct: Number((((measured.seconds - 6) / 6) * 100).toFixed(4)),
		pass: Math.abs(cents) < 5 && Math.abs((measured.seconds - 6) / 6) < 0.01,
	};
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

function sendJson(res, code, payload) {
	try {
		res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(payload));
	} catch {
		/* client gone */
	}
}

/** 设备列表刷新状态（/api/export-log 用；定义在此以保证 config 已初始化）。 */
function outputDeviceAvailable() {
	if (config.outputDeviceId === null || config.outputDeviceId === undefined) return false;
	return (deps?.render ?? []).some((item) => item.id === config.outputDeviceId);
}

async function status() {
	// 设备列表 3 秒 TTL 刷新：蓝牙耳机等热插拔设备连上后就能出现在列表里。
	// 并发请求由 devicesRefreshing 互斥，不会在同一时刻重复枚举。
	await refreshDevicesIfStale();
	if (deps === null) deps = await detect();
	const running = runtime.producer !== null;
	const info = runtime.rendererInfo;
	const available = outputDeviceAvailable();
	const savedOutputMissing = !available && config.outputDeviceId !== null && config.outputDeviceId !== undefined;
	// 延迟估算：渲染端缓冲（bufferFrames / 设备采样率）+ dshow 捕获缓冲。
	const bufferMs = info !== null && info !== undefined ? Math.round((info.bufferFrames / Math.max(1, info.deviceRate)) * 1000) : null;
	const latencyMs = bufferMs === null ? null : bufferMs + Number(config.bufferMs || 0);
	return {
		ok: true,
		phase: runtime.phase,
		running,
		uptimeMs: running ? Date.now() - runtime.startedAt : 0,
		targetHz: Number(config.targetHz),
		ratio: Number((Number(config.targetHz) / REF_HZ).toFixed(8)),
		cents: Number((1200 * Math.log2(Number(config.targetHz) / REF_HZ)).toFixed(2)),
		config,
		// 已保存的输出设备当前是否还在（蓝牙/耳机拔出 → false，界面据此提示「设备已断开」）。
		// 注意：设备消失不会清空 config.outputDeviceId，保留原值以便设备回来后自动恢复。
		outputDeviceAvailable: available,
		savedOutputMissing,
		outputDeviceName: config.outputDeviceName,
		devices: deviceListState(),
		levels: runtime.levels,
		renderer: info,
		latencyMs,
		latencyBreakdown: { outputBufferMs: bufferMs, captureBufferMs: Number(config.bufferMs || 0) },
		singleFile: SINGLE_FILE,
		launchAtLogin: autoStartEnabled(),
		singleInstance: { port: PORT, alreadyRunning: true },
		/** 接管前的默认设备快照（界面用它显示「停止后将还原到 XXX」）。 */
		defaultSnapshot: runtime.defaultSnapshot,
		/** 最近一次停止时的还原结果。 */
		lastRestore: runtime.lastRestore,
		/** 当前系统默认播放设备是否还指向虚拟声卡（界面对此给出一键还原）。 */
		defaultIsCable: (() => {
			try {
				const cur = deps?.defaultRender?.id ?? null;
				return cur !== null && deps?.vcable?.renderId !== null && cur === deps.vcable.renderId;
			} catch {
				return false;
			}
		})(),
		lastError: runtime.lastError,
		deps: {
			ffmpeg: deps.ffmpeg,
			hasDshow: deps.hasDshow,
			vcable: deps.vcable,
			endpointTool: deps.endpointTool,
			renderTool: deps.renderTool,
			defaultRender: deps.defaultRender,
			// 字段名与结构保持不变（界面在用）：只含 state==='active' 且非 CABLE 的物理输出设备
			render: physicalRender(deps),
		},
		logs: runtime.logs.slice(-200),
	};
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const path = url.pathname;

	if (path.startsWith("/api/")) {
		try {
			if (path === "/api/status") {
				sendJson(res, 200, await status());
				return;
			}
			if (path === "/api/start") {
				sendJson(res, 200, await startEngine("ui"));
				return;
			}
			if (path === "/api/stop") {
				sendJson(res, 200, await stopEngine("ui"));
				return;
			}
			if (path === "/api/devices") {
				deps = await detect();
				sendJson(res, 200, { ok: true, render: deps.render, capture: deps.capture, vcable: deps.vcable, defaultRender: deps.defaultRender });
				return;
			}
			if (path === "/api/logs") {
				// 最近 N 行（默认 300，上限 2000）：内存环形缓冲 + app.log + engine.log 合并去重按时间排序。
				const tail = clamp(url.searchParams.get("tail") ?? 300, 1, 2000);
				sendJson(res, 200, { ok: true, lines: collectLogLines(Math.round(tail)), files: { app: APP_LOG_FILE, engine: LOG_FILE } });
				return;
			}
			if (path === "/api/export-log") {
				// 完整日志导出：版本 + 时间 + 依赖探测 + 配置 JSON + 最近 1000 行日志。
				const body = buildLogExport();
				res.writeHead(200, {
					"content-type": "text/plain; charset=utf-8",
					"content-disposition": 'attachment; filename="432hz-player.log"',
					"content-length": Buffer.byteLength(body),
					"cache-control": "no-store",
				});
				res.end(body);
				return;
			}
			if (path === "/api/config") {
				const raw = await new Promise((resolveBody, rejectBody) => {
					let data = "";
					req.on("data", (chunk) => {
						data += chunk;
						if (data.length > 65536) rejectBody(new Error("too large"));
					});
					req.on("end", () => resolveBody(data));
					req.on("error", rejectBody);
				});
				const patch = raw.trim() === "" ? {} : JSON.parse(raw);
				const before = { ...config };
				if (patch.targetHz !== undefined) config.targetHz = clamp(patch.targetHz, 415, 445);
				if (patch.gainDb !== undefined) config.gainDb = clamp(patch.gainDb, -12, 12);
				if (patch.mix !== undefined) config.mix = clamp(patch.mix, 0, 1);
				if (patch.limiter !== undefined) config.limiter = patch.limiter === true;
				if (patch.highQuality !== undefined) config.highQuality = patch.highQuality === true;
				if (patch.bufferMs !== undefined) config.bufferMs = clamp(patch.bufferMs, 50, 2000);
				if (patch.outputDeviceId !== undefined) {
					config.outputDeviceId = patch.outputDeviceId;
					const found = deps?.render?.find((item) => item.id === patch.outputDeviceId);
					config.outputDeviceName = found?.name ?? null;
				}
				if (patch.autoStart !== undefined) config.autoStart = patch.autoStart === true;
				if (patch.forceCableDefault !== undefined) config.forceCableDefault = patch.forceCableDefault === true;
				if (patch.captureDeviceName !== undefined) config.captureDeviceName = patch.captureDeviceName || null;
				// 用户人工确认已自己改回系统默认设备 → 清空快照与残留提示
				if (patch.defaultDeviceSnapshot === null) {
					config.defaultDeviceSnapshot = null;
					runtime.defaultSnapshot = null;
					runtime.lastRestore = null;
				}
				saveConfig();
				const needsRestart = ["targetHz", "gainDb", "mix", "limiter", "highQuality", "bufferMs", "captureDeviceName"]
					.some((key) => before[key] !== config[key]);
				if (needsRestart && runtime.producer !== null) {
					runtime.restarting = true;
					await stopEngine("参数变更");
					const report = await startEngine("参数变更");
					runtime.restarting = false;
					sendJson(res, 200, { ok: report.ok === true, restarted: true, report });
					return;
				}
				sendJson(res, 200, { ok: true, restarted: false });
				return;
			}
			if (path === "/api/selftest") {
				sendJson(res, 200, await selfTest());
				return;
			}
			if (path === "/api/autostart") {
				const raw = await new Promise((resolveBody) => {
					let data = "";
					req.on("data", (chunk) => {
						data += chunk;
					});
					req.on("end", () => resolveBody(data));
				});
				const body = raw.trim() === "" ? {} : JSON.parse(raw);
				if (body.enabled === undefined) {
					sendJson(res, 200, { ok: true, enabled: autoStartEnabled(), path: SHORTCUT, singleFile: SINGLE_FILE });
					return;
				}
				const result = await setAutoStart(body.enabled === true);
				config.launchAtLogin = result.enabled === true;
				saveConfig();
				sendJson(res, 200, { ...result, singleFile: SINGLE_FILE });
				return;
			}
			if (path === "/api/open-sound-settings") {
				// 降级路径：本机无法用接口切换默认设备时，直接把用户送到系统声音设置。
				try {
					spawn("cmd.exe", ["/c", "start", "", "ms-settings:sound"], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
					sendJson(res, 200, { ok: true });
				} catch (error) {
					sendJson(res, 200, { ok: false, error: String(error?.message ?? error) });
				}
				return;
			}
			if (path === "/api/restore-default-device") {
				// 手动还原：把系统默认播放设备换回接管前那个（或用户指定的物理设备）
				const raw = await new Promise((resolveBody) => {
					let data = "";
					req.on("data", (chunk) => { data += chunk; });
					req.on("end", () => resolveBody(data));
				});
				let body = {};
				try { body = raw.trim() === "" ? {} : JSON.parse(raw); } catch { body = {}; }
				if (typeof body.deviceId === "string" && body.deviceId !== "") {
					const sw = await runJson(ENDPOINT_EXE, ["set-render", body.deviceId], 20000);
					const after = await runJson(ENDPOINT_EXE, ["default"], 12000);
					const ok = sw.ok === true && after?.ok === true && after.render?.id === body.deviceId;
					sendJson(res, 200, { ok, to: after?.render?.name ?? null, error: ok ? undefined : (sw.error ?? "设置失败") });
					return;
				}
				const report = await restoreDefaultDevice("手动还原");
				sendJson(res, 200, report);
				return;
			}
			if (path === "/api/quit") {
				sendJson(res, 200, { ok: true, quitting: true });
				setTimeout(() => void shutdown(), 250);
				return;
			}
			if (path === "/api/diagnostic") {
				// 端到端链路自检：用合成音源跑真实引擎（含 WASAPI 直出），不影响系统默认设备。
				if (runtime.producer !== null) {
					sendJson(res, 200, { ok: false, error: "请先停止接管再自检" });
					return;
				}
				const seconds = 3;
				const runDiag = await diagnosticRun(seconds);
				sendJson(res, 200, runDiag);
				return;
			}
			sendJson(res, 404, { ok: false, error: "not found" });
		} catch (error) {
			sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
		return;
	}

	// 静态 UI
	serveStatic(res, path);
});

/** 单文件模式下 UI 内联在 globalThis.__HZ432_HTML__；开发模式读 web/index.html。 */
function readUiHtml() {
	try {
		if (typeof globalThis.__HZ432_HTML__ === "string") return globalThis.__HZ432_HTML__;
	} catch {
		/* ignore */
	}
	const file = join(WEB_DIR, "index.html");
	return existsSync(file) ? readFileSync(file, "utf8") : "<h1>UI 缺失</h1>";
}

/** 静态资源：单文件模式内联 index.html（界面无外部依赖），开发模式读磁盘。 */
function serveStatic(res, pathname) {
	if (pathname === "/" || pathname === "/index.html") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(readUiHtml());
		return;
	}
	const rel = normalize(pathname).replace(/^[\\/]+/, "");
	const file = join(WEB_DIR, rel);
	if (!file.startsWith(WEB_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
		res.writeHead(404);
		res.end("not found");
		return;
	}
	res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
	createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// 开机自启（开始菜单「启动」目录里的快捷方式）
// ---------------------------------------------------------------------------
const STARTUP_DIR = join(process.env.APPDATA ?? homedir(), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const SHORTCUT = join(STARTUP_DIR, "432Hz 播放器.lnk");

/** 本程序的可执行文件（单文件 exe 时就是自己）。 */
const selfExe = () => process.execPath;
/** 单文件 exe 无参数；开发模式需要带脚本路径。 */
const selfArgs = () => (SINGLE_FILE ? "" : `"${join(APP_DIR, "server.mjs")}"`);
const autoStartEnabled = () => existsSync(SHORTCUT);

/** 写入/移除开机自启快捷方式（PowerShell + WScript.Shell 创建 .lnk）。 */
async function setAutoStart(enabled) {
	mkdirSync(STARTUP_DIR, { recursive: true });
	if (enabled !== true) {
		try {
			if (existsSync(SHORTCUT)) rmSync(SHORTCUT, { force: true });
			return { ok: true, enabled: false, path: SHORTCUT };
		} catch (error) {
			return { ok: false, error: String(error?.message ?? error) };
		}
	}
	const quote = (value) => String(value).replace(/'/g, "''");
	const icon = SINGLE_FILE ? selfExe() : join(APP_DIR, "assets", "app.ico");
	const script = [
		"$ws = New-Object -ComObject WScript.Shell;",
		`$lnk = $ws.CreateShortcut('${quote(SHORTCUT)}');`,
		`$lnk.TargetPath = '${quote(selfExe())}';`,
		`$lnk.Arguments = '${quote(selfArgs())} --silent';`,
		`$lnk.WorkingDirectory = '${quote(APP_DIR)}';`,
		"$lnk.Description = '432Hz 播放器：开机静默启动，自动把系统音频转 432Hz 输出';",
		`$lnk.IconLocation = '${quote(icon)}';`,
		"$lnk.Save();",
	].join(" ");
	const out = await runSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], 20000);
	if (out.code !== 0 || !existsSync(SHORTCUT)) {
		return { ok: false, error: (out.stderr || "创建快捷方式失败").slice(-300) };
	}
	return { ok: true, enabled: true, path: SHORTCUT };
}

// ---------------------------------------------------------------------------
// 打开应用窗口（Chrome/Edge 应用模式；已开着就不重复开）
// ---------------------------------------------------------------------------
async function openWindow(url) {
	const files = [
		join(process.env.ProgramFiles ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
		join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
		join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
		join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
		join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
	];
	const browser = files.find((p) => p !== "" && existsSync(p));
	if (browser === undefined) {
		try {
			spawn("cmd.exe", ["/c", "start", "", url], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
			return { ok: true, browser: "default" };
		} catch (error) {
			return { ok: false, error: String(error?.message ?? error) };
		}
	}
	const base = basename(browser);
	try {
		const list = await runSync("powershell.exe", ["-NoProfile", "-Command",
			`(Get-CimInstance Win32_Process -Filter "Name='${base}'" | Where-Object { $_.CommandLine -like '*--app=${url}*' } | Measure-Object).Count`], 12000);
		if (Number(String(list.stdout).trim()) > 0) return { ok: true, browser, alreadyOpen: true };
	} catch {
		/* 查询失败则直接打开 */
	}
	try {
		spawn(browser, [`--app=${url}`, "--window-size=980,1240"], { detached: true, stdio: "ignore" }).unref();
		return { ok: true, browser };
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error) };
	}
}

/** 诊断：合成音源直连渲染器（不碰系统默认设备、不占用 CABLE）。 */
async function diagnosticRun(seconds) {
	if (deps === null) deps = await detect();
	if (deps.ffmpeg === null || !deps.renderTool) return { ok: false, error: "缺少 ffmpeg 或 AudioRender.exe" };
	const outId = config.outputDeviceId;
	if (outId === null) return { ok: false, error: "未选择输出设备" };
	const rate = 48000;
	const chain = buildFilterChain({ rate, targetHz: config.targetHz, gainDb: config.gainDb, mix: config.mix, limiter: config.limiter, highQuality: config.highQuality });
	const ffArgs = [
		"-hide_banner", "-loglevel", "error",
		"-re", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${rate}:duration=${seconds}`,
		"-af", chain,
		"-f", "s16le", "-ar", String(rate), "-ac", "2", "-",
	];
	const renderArgs = ["--device", outId, "--rate", String(rate), "--channels", "2", "--format", "s16", "--stats-ms", "500"];
	const renderer = spawn(RENDER_EXE, renderArgs, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	const producer = spawn(deps.ffmpeg, ffArgs, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	producer.stdout.pipe(renderer.stdin);
	let rendererInfo = null;
	let levels = null;
	let buffer = "";
	renderer.stderr.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line.startsWith("{")) {
				try {
					const parsed = JSON.parse(line);
					if (parsed.ready === true) rendererInfo = parsed;
					else if (parsed.evt === "level") levels = parsed;
				} catch {
					/* ignore */
				}
			}
			index = buffer.indexOf("\n");
		}
	});
	await new Promise((r) => producer.on("exit", r));
	await new Promise((r) => setTimeout(r, 800));
	try {
		renderer.stdin.end();
		renderer.kill();
	} catch {
		/* ignore */
	}
	return {
		ok: rendererInfo?.ready === true && Number(levels?.frames ?? 0) > 0,
		renderer: rendererInfo,
		levels,
		chain,
	};
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

/** 命令行开关：--silent 静默（不开窗口，供开机自启）、--stop 停止已运行的实例、--auto-start on|off、--no-open。 */
const ARGV = process.argv.slice(2);
const hasFlag = (name) => ARGV.includes(name);

/** 
 * 停止已在运行的实例：本程序是普通软件，不做「互斥锁」式阻拦；
 * 若端口被占用，说明已经开着一份，此时直接打开它的窗口即可。
 * @returns 端口是否已被本程序占用。
 */
async function isOurInstanceRunning() {
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(2500) });
		const data = await res.json();
		return data?.ok === true && typeof data.phase === "string";
	} catch {
		return false;
	}
}

/**
 * 启动前把 stdout/stderr 兜底重定向到日志文件。
 *
 * GUI 子系统（IMAGE_SUBSYSTEM_WINDOWS_GUI=2）下进程没有控制台：若 stdout 被接到一个已断开的
 * 管道，写入会抛 EPIPE。重定向后所有 console.* / process.stdout.write 都落到 app.log，
 * 既不会抛错，也让「没有窗口」时仍有完整日志可查。任何一步失败都静默跳过（原流保持可用）。
 * @returns 是否重定向成功。
 */
function reattachStdStreamsToLog() {
	try {
		mkdirSync(DATA_DIR, { recursive: true });
		const file = join(DATA_DIR, "stdout.log");
		const fd = openSync(file, "a");
		const stream = createWriteStream(null, { fd, flags: "a" });
		stream.on("error", () => {});
		const wrap = (original) => ({
			write: (chunk, encoding, callback) => {
				try {
					return stream.write(chunk, encoding, callback);
				} catch {
					return true;
				}
			},
			on: (...args) => {
				try {
					return original.on(...args);
				} catch {
					return original;
				}
			},
			once: (...args) => {
				try {
					return original.once(...args);
				} catch {
					return original;
				}
			},
			end: () => {},
			destroy: () => {},
			columns: 120,
			isTTY: false,
			_wrapped: true,
		});
		for (const name of ["stdout", "stderr"]) {
			const original = process[name];
			if (original?._wrapped === true) continue;
			const replacement = wrap(original);
			try {
				Object.defineProperty(process, name, { value: replacement, writable: true, configurable: true });
			} catch {
				/* 定义失败就保持原流：log() 内部还有 try/catch 兜底 */
			}
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * 启动服务（可作为库调用 —— Electron 外壳就在同进程里用它）。
 * @param options.port 监听端口（默认 4399 / HZ432_PORT）
 * @param options.openWindow 启动后是否打开界面窗口（Electron 下传 false，由外壳自己开窗口）
 * @param options.autoStartEngine 是否自动开始接管（默认读配置）
 * @param options.attachStreams 是否把 stdout/stderr 兜底到日志（单文件 GUI 模式需要）
 * @returns {Promise<{ok:boolean, port:number, url:string, close:Function, error?:string}>}
 */
export async function startServer(options = {}) {
	const port = Number(options.port ?? PORT);
	const shouldOpenWindow = options.openWindow !== false;
	const attach = options.attachStreams ?? SINGLE_FILE;

	if (attach) {
		const attached = reattachStdStreamsToLog();
		log(`stdout/stderr → 日志文件：${attached ? "已重定向" : "重定向失败（log() 内部 try/catch 兜底）"}`);
	}

	return await new Promise((resolve) => {
		const onError = (error) => {
			if (error?.code === "EADDRINUSE") resolve({ ok: false, port, url: `http://127.0.0.1:${port}/`, error: "端口已被占用（可能已有一个实例在运行）", close: () => {} });
			else resolve({ ok: false, port, url: `http://127.0.0.1:${port}/`, error: String(error?.message ?? error), close: () => {} });
		};
		server.once("error", onError);
		server.listen(port, "127.0.0.1", async () => {
			server.off("error", onError);
			log(`432Hz 播放器已启动: http://127.0.0.1:${port}${SINGLE_FILE ? "（单文件模式）" : ""}`);
			deps = await detect();
			await refreshDevicesIfStale().catch(() => {});

			// 输出设备兜底：优先用「上次选过的」；没有就取当前物理默认设备，默认是 CABLE 时取第一个物理设备
			if (config.outputDeviceId === null) {
				const picked = pickPhysicalOutput();
				if (picked !== null) {
					config.outputDeviceId = picked.id;
					config.outputDeviceName = picked.name;
					saveConfig();
					log(`未选择输出设备，自动选中物理设备：${picked.name}`);
				}
			} else if (config.outputDeviceName === null) {
				const found = deps.render.find((item) => item.id === config.outputDeviceId);
				if (found !== undefined) {
					config.outputDeviceName = found.name;
					saveConfig();
				}
			}

			const wantAuto = options.autoStartEngine ?? config.autoStart === true;

			// 启动自愈：默认设备指向 CABLE，但本次不接管（上次崩溃/被强杀留下的残留）
			// → 会表现为「电脑没声音」，必须换回物理设备。
			if (wantAuto !== true) {
				try {
					const cur = await runJson(ENDPOINT_EXE, ["default"], 12000);
					const cableId = deps?.vcable?.renderId ?? null;
					if (cableId !== null && cur?.ok === true && cur.render?.id === cableId) {
						const snap = runtime.defaultSnapshot ?? config.defaultDeviceSnapshot ?? null;
						const target = snap?.renderId ?? (config.outputDeviceId !== null && config.outputDeviceId !== cableId ? config.outputDeviceId : null);
						if (target !== null) {
							const sw = await runJson(ENDPOINT_EXE, ["restore", target, "null"], 20000);
							runtime.lastRestore = { ok: sw.ok === true, restored: sw.ok === true, to: snap?.renderName ?? config.outputDeviceName ?? target, reason: "启动自愈" };
							log(`启动自愈：默认设备原指向 CABLE，已换回「${runtime.lastRestore.to}」（${sw.ok ? "成功" : "失败"}）`);
						} else {
							log("启动自愈：默认设备指向 CABLE，但未找到可用的物理播放设备，请在系统声音设置里手动选择");
						}
					}
				} catch (error) {
					log("启动自愈失败（忽略）：", String(error?.message ?? error));
				}
			}

			if (wantAuto === true && runtime.producer === null) {
				const report = await startEngine("auto");
				log("auto-start:", JSON.stringify(report).slice(0, 300));
			}

			if (shouldOpenWindow && !hasFlag("--silent") && !hasFlag("--no-open")) {
				const opened = await openWindow(`http://127.0.0.1:${port}/`);
				log("window:", JSON.stringify(opened));
			}
			resolve({
				ok: true,
				port,
				url: `http://127.0.0.1:${port}/`,
				close: () => {
					try {
						server.close();
					} catch {
						/* ignore */
					}
				},
			});
		});
	});
}

async function main() {
	// --stop：让已在运行的实例自己退出（引擎随之停止）
	if (hasFlag("--stop")) {
		try {
			await fetch(`http://127.0.0.1:${PORT}/api/quit`, { method: "POST", signal: AbortSignal.timeout(4000) });
			console.log("已请求退出运行中的实例。");
		} catch {
			console.log("没有正在运行的实例。");
		}
		return;
	}

	// 已经开着一份：不再起服务，只把窗口调出来（软件该有的行为）
	if (await isOurInstanceRunning()) {
		log("已有实例在运行，直接打开窗口");
		if (!hasFlag("--silent")) await openWindow(`http://127.0.0.1:${PORT}/`);
		return;
	}

	// --auto-start on|off：写/删启动目录快捷方式
	const idx = ARGV.indexOf("--auto-start");
	if (idx >= 0) {
		const value = ARGV[idx + 1];
		const result = await setAutoStart(value === "on");
		log("auto-start:", JSON.stringify(result));
		if (value !== "on" && value !== "off") console.log("用法: --auto-start on|off");
		else console.log(result.ok ? (result.enabled ? "已设置开机自启。" : "已关闭开机自启。") : `设置失败：${result.error}`);
		return;
	}

	// --open-window：让已在运行的实例弹一次窗口（Electron 回退路径用）
	if (hasFlag("--open-window")) {
		await openWindow(`http://127.0.0.1:${PORT}/`);
		console.log("已请求打开界面窗口。");
		return;
	}

	const result = await startServer({});
	if (result.ok !== true) {
		log(result.error ?? "启动失败");
		process.exit(1);
	}
}

const shutdown = async () => {
	log("shutting down");
	try {
		await stopEngine("exit");
	} catch {
		/* ignore */
	}
	// 兜底：即使上面某步失败，也要保证默认设备不再指向虚拟声卡（否则用户没声音）
	try {
		const cur = await runJson(ENDPOINT_EXE, ["default"], 8000);
		const cableId = deps?.vcable?.renderId ?? null;
		if (cableId !== null && cur?.ok === true && cur.render?.id === cableId && runtime.defaultSnapshot !== null) {
			await runJson(ENDPOINT_EXE, ["restore", runtime.defaultSnapshot.renderId, "null"], 12000);
			log("退出兜底：已还原默认播放设备");
		}
	} catch {
		/* ignore */
	}
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// 进程被杀（含崩溃）时的同步兜底：默认设备若仍指向 CABLE 就换回快照里的物理设备。
// 用 spawnSync 保证在退出前完成（异步在这里来不及）。
process.on("exit", () => {
	try {
		const snap = runtime.defaultSnapshot;
		if (snap === null || snap.renderId === null) return;
		const out = execFileSync(ENDPOINT_EXE, ["default"], { encoding: "utf8", timeout: 4000, windowsHide: true });
		const parsed = JSON.parse(out.trim().split(/\r?\n/).pop() ?? "{}");
		const cableId = deps?.vcable?.renderId ?? null;
		if (cableId !== null && parsed?.render?.id === cableId) {
			execFileSync(ENDPOINT_EXE, ["restore", snap.renderId, "null"], { timeout: 6000, windowsHide: true });
		}
	} catch {
		/* 退出路径不能抛错 */
	}
});

/**
 * 是否「作为程序直接运行」而不是被 import 进来的。
 * 关键：Electron 外壳会 `import` 本模块来复用 startServer()；若此时 main() 也执行，
 * 就会出现两个监听抢同一端口（EADDRINUSE → process.exit(1) 把外壳一起杀掉）。
 * 单文件 exe（SEA）里没有 argv[1] 文件路径，按「直接运行」处理。
 */
function isDirectRun() {
	if (SINGLE_FILE) return true;
	try {
		const entry = process.argv[1];
		if (entry === undefined) return true;
		const here = fileURLToPath(import.meta.url);
		const resolved = resolve(entry);
		if (resolved === here) return true;
		// Electron 打包/开发下 argv[1] 可能是 "." 或目录
		return false;
	} catch {
		return false;
	}
}

if (isDirectRun()) main();
