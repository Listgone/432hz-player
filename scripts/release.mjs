#!/usr/bin/env node
/**
 * 一键打包 + 发布到 GitHub Release。
 *
 * 产物（三个）：
 *   1. 432hz-player-<v>-setup.exe      Electron 安装包（推荐）
 *   2. 432hz-player-<v>-portable.exe  Electron 便携版
 *   3. 432hz-player-standalone.exe     单文件版（需与同目录 tools/ 放一起）
 *
 * 用法：
 *   node scripts/release.mjs                 # 打包 + 创建/更新 Release（tag = v<version>）
 *   node scripts/release.mjs --no-build      # 只用现有产物发布
 *   node scripts/release.mjs --tag v1.1.0    # 指定 tag
 *
 * 注意：
 *   - 需要 gh CLI 已登录（gh auth login）。
 *   - 上传后可在 Release 页面核对三个附件与说明。
 *   - 单文件版 exe 有 88MB，在 GitHub 单文件 100MB 限制以内，可直接上传。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8"));
const version = pkg.version;
const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const tagIndex = args.indexOf("--tag");
const tag = tagIndex >= 0 ? args[tagIndex + 1] : `v${version}`;

const run = (file, list, options = {}) => {
	execFileSync(file, list, { stdio: "inherit", cwd: APP, ...options });
};
/** gh 命令统一在这里调用：Windows 下 .exe 可直接执行，不需要经 shell（避免多行参数被截断）。 */
const runGh = (list) => run(process.platform === "win32" ? "gh.exe" : "gh", list);
const note = (...a) => console.log("[release]", ...a);

const RELEASE_DIR = join(APP, "release");
const STANDALONE_DIR_NAME = "432hz-player-standalone";
const standaloneZip = join(RELEASE_DIR, `432hz-player-${version}-standalone-win-x64.zip`);
const artifacts = [
	join(RELEASE_DIR, `432hz-player-${version}-setup.exe`),
	join(RELEASE_DIR, `432hz-player-${version}-portable.exe`),
	join(APP, "432hz-player-standalone.exe"),
	standaloneZip,
];

/**
 * 打一个「单文件版 + tools」的 zip：单文件版必须与 tools/ 同目录才能跑，
 * 用户只下 exe 会报「缺少 AudioRender.exe」，所以提供整包。
 */
function packStandalone() {
	const stage = join(RELEASE_DIR, STANDALONE_DIR_NAME);
	rmSync(stage, { recursive: true, force: true });
	mkdirSync(join(stage, "tools"), { recursive: true });
	copyFileSync(join(APP, "432hz-player-standalone.exe"), join(stage, "432hz-player-standalone.exe"));
	for (const tool of ["AudioEndpoint.exe", "AudioRender.exe"]) {
		copyFileSync(join(APP, "tools", tool), join(stage, "tools", tool));
	}
	copyFileSync(join(APP, "README.md"), join(stage, "README.md"));
	rmSync(standaloneZip, { force: true });
	execFileSync("powershell.exe", [
		"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
		`Compress-Archive -Path '${join(stage, "*")}' -DestinationPath '${standaloneZip}' -Force`,
	], { stdio: "inherit", cwd: APP });
	rmSync(stage, { recursive: true, force: true });
}

/** 生成 SHA256SUMS.txt，便于用户校验下载完整性。 */
function writeChecksums(list) {
	const crypto = createHash("sha256");
	const lines = [];
	for (const file of list) {
		const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
		lines.push(`${hash}  ${basename(file)}`);
	}
	void crypto;
	const out = join(RELEASE_DIR, "SHA256SUMS.txt");
	writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
	return out;
}

/** 探测各加速镜像是否可用（HEAD，超时 8s），写进 Release 说明。 */
async function probeMirrors(assetUrl) {
	const mirrors = ["https://ghproxy.net/", "https://ghfast.top/", "https://gh-proxy.com/"];
	const rows = [];
	for (const mirror of mirrors) {
		const url = mirror + assetUrl;
		const started = Date.now();
		try {
			const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
			rows.push({ mirror, ok: res.ok, ms: Date.now() - started });
		} catch {
			rows.push({ mirror, ok: false, ms: Date.now() - started });
		}
	}
	return rows;
}

if (!noBuild) {
	note("1/5 编译 C# 工具（若已存在会覆盖）…");
	// Windows 下用 csc 直接编译；失败不阻断（仓库里已带 exe）
	try {
		const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
		if (existsSync(csc)) {
			for (const [name] of [["AudioEndpoint"], ["AudioRender"]]) {
				run(csc, ["/nologo", "/optimize+", "/platform:x64", `/out:${join(APP, "tools", `${name}.exe`)}`, join(APP, "tools", `${name}.cs`)]);
			}
			note("   C# 工具编译完成");
		} else {
			note("   跳过：未找到 csc.exe（使用仓库里已有的 exe）");
		}
	} catch (error) {
		note("   C# 工具编译失败（使用已有 exe）：", String(error?.message ?? error));
	}

	note("2/5 生成图标…");
	run(process.execPath, [join(HERE, "make-icon.mjs")]);

	note("3/5 打包 Electron（安装包 + 便携版）…");
	run("npx", ["electron-builder", "--win", "nsis", "portable", "--x64"]);

	note("4/5 打包单文件版…");
	run(process.execPath, [join(HERE, "build-exe.mjs")]);

	note("5/5 打独立整包 zip（单文件版 + tools）…");
	packStandalone();
} else if (!existsSync(standaloneZip)) {
	note("补打独立整包 zip（单文件版 + tools）…");
	packStandalone();
}

const missing = artifacts.filter((p) => !existsSync(p));
if (missing.length > 0) {
	console.error("[release] 缺少产物，先运行不带 --no-build 的完整打包：");
	for (const p of missing) console.error("   -", p);
	process.exit(1);
}
for (const p of artifacts) note(`产物 ${(statSync(p).size / 1048576).toFixed(1)} MiB  ${p}`);

// 从 origin 推断仓库全名
let repo = "";
try {
	repo = execFileSync("git", ["remote", "get-url", "origin"], { cwd: APP, encoding: "utf8" }).trim();
} catch {
	/* 忽略 */
}
const repoName = repo.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/");
if (repoName === "") {
	console.error("[release] 无法从 git remote 推断仓库名");
	process.exit(1);
}

// 校验文件（附在 Release 里，用户可核对下载完整性）
const checksumsFile = writeChecksums(artifacts);
artifacts.push(checksumsFile);
note("已生成校验文件：", basename(checksumsFile));

// 探测加速镜像可用性，写进 Release 说明（避免文档里的链接静默失效）
const primaryAsset = `https://github.com/${repoName}/releases/download/${tag}/432hz-player-${version}-setup.exe`;
const mirrors = await probeMirrors(primaryAsset);
const mirrorRows = mirrors.map((m) => `| \`${m.mirror.replace(/^https:\/\//, "").replace(/\/$/, "")}\` | ${m.ok ? "可用" : "当前不可用"} | ${m.ms} ms |`).join("\n");

const notes = [
	`## 432Hz 播放器 ${tag}`,
	"",
	"把系统正在播放的声音实时转成 **432Hz**（A4 440 → 432，−31.77 cent，保时长）后送到物理声卡。",
	"",
	"### 产物",
	"",
	"| 文件 | 说明 |",
	"|---|---|",
	`| \`432hz-player-${version}-setup.exe\` | **推荐**：安装版（桌面应用，独立窗口 + 托盘常驻） |`,
	`| \`432hz-player-${version}-portable.exe\` | 免安装便携版 |`,
	`| \`432hz-player-${version}-standalone-win-x64.zip\` | 单文件版**整包**（含 tools/，解压即用） |`,
	"| `432hz-player-standalone.exe` | 单文件版 exe（需与 `tools\\` 目录放一起） |",
	"| `SHA256SUMS.txt` | 各文件 SHA-256 校验值 |",
	"",
	"### 使用前提",
	"",
	"1. 安装 **VB-CABLE**（<https://vb-audio.com/Cable/>，管理员运行后**重启电脑**）",
	"2. 安装 **ffmpeg**：`winget install --id Gyan.FFmpeg -e`",
	"",
	"启动后会自动把系统默认播放设备指向 `CABLE Input` 并开始接管；停止/退出时会自动还原。",
	"",
	"### 下载慢？",
	"",
	"在原始下载链接**前面拼接**镜像前缀即可加速：",
	"",
	"```text",
	`https://ghproxy.net/${primaryAsset}`,
	"```",
	"",
	"| 镜像 | 本次实测 | 响应 |",
	"|---|---|---|",
	mirrorRows,
	"",
	"完整说明见仓库 README 的「下载慢？」一节。",
	"",
	"### 校验",
	"",
	`- 版本：\`${version}\``,
	`- 打包时间：${new Date().toISOString()}`,
	"- 校验：`certutil -hashfile <文件> SHA256` 后与 `SHA256SUMS.txt` 对照",
].join("\n");

const notesFile = join(APP, "release", "RELEASE_NOTES.md");
writeFileSync(notesFile, notes, "utf8");

const exists = (() => {
	try {
		execFileSync(process.platform === "win32" ? "gh.exe" : "gh", ["release", "view", tag, "--repo", repoName], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

if (exists) {
	note(`Release ${tag} 已存在 → 更新说明并覆盖上传附件`);
	runGh(["release", "edit", tag, "--repo", repoName, "--notes-file", notesFile, "--title", `432Hz 播放器 ${tag}`]);
	runGh(["release", "upload", tag, "--repo", repoName, ...artifacts, "--clobber"]);
} else {
	note(`创建 Release ${tag}（${repoName}）`);
	runGh(["release", "create", tag, "--repo", repoName, "--title", `432Hz 播放器 ${tag}`, "--notes-file", notesFile, ...artifacts]);
}

note("完成。");
try {
	const url = execFileSync(process.platform === "win32" ? "gh.exe" : "gh", ["release", "view", tag, "--repo", repoName, "--json", "url", "--jq", ".url"], { encoding: "utf8" }).trim();
	note("Release 地址：", url);
} catch {
	/* 忽略 */
}
