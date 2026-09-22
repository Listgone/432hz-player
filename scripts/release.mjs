#!/usr/bin/env node
/**
 * 一键打包 + 发布到 GitHub Release。
 *
 * 产物（三个）：
 *   1. 432Hz Player-<v>-x64.exe       Electron 安装包（推荐）
 *   2. 432Hz Player-<v>-portable.exe  Electron 便携版
 *   3. 432Hz播放器.exe                 单文件版（不含 Node 运行时依赖，需同目录 tools/）
 *
 * 用法：
 *   node scripts/release.mjs                 # 打包 + 创建/更新 Release（tag = v<version>）
 *   node scripts/release.mjs --no-build      # 只用现有产物发布
 *   node scripts/release.mjs --tag v1.1.0    # 指定 tag
 *
 * 注意：
 *   - 需要 gh CLI 已登录（gh auth login）。
 *   - 私有仓库也能发 Release，但**第三方加速镜像无法代理私有内容**；
 *     仓库公开后加速链接才会生效（见 README「下载与加速」一节）。
 *   - 单文件版 exe 有 88MB，超过 GitHub 单文件 100MB 限制以内，可直接上传。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
	execFileSync(file, list, { stdio: "inherit", cwd: APP, shell: process.platform === "win32", ...options });
};
const note = (...a) => console.log("[release]", ...a);

const RELEASE_DIR = join(APP, "release");
const artifacts = [
	join(RELEASE_DIR, `432Hz Player-${version}-x64.exe`),
	join(RELEASE_DIR, `432Hz Player-${version}-portable.exe`),
	join(APP, "432Hz播放器.exe"),
];

if (!noBuild) {
	note("1/4 编译 C# 工具（若已存在会覆盖）…");
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

	note("2/4 生成图标…");
	run(process.execPath, [join(HERE, "make-icon.mjs")]);

	note("3/4 打包 Electron（安装包 + 便携版）…");
	run("npx", ["electron-builder", "--win", "nsis", "portable", "--x64"]);

	note("4/4 打包单文件版…");
	run(process.execPath, [join(HERE, "build-exe.mjs")]);
}

const missing = artifacts.filter((p) => !existsSync(p));
if (missing.length > 0) {
	console.error("[release] 缺少产物，先运行不带 --no-build 的完整打包：");
	for (const p of missing) console.error("   -", p);
	process.exit(1);
}
for (const p of artifacts) note(`产物 ${(statSync(p).size / 1048576).toFixed(1)} MiB  ${p}`);

// 私有仓库：从 origin 推断仓库全名
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

const notes = [
	`## 432Hz 播放器 ${tag}`,
	"",
	"把系统正在播放的声音实时转成 **432Hz**（A4 440 → 432，−31.77 cent，保时长）后送到物理声卡。",
	"",
	"### 三个产物",
	"",
	"| 文件 | 说明 |",
	"|---|---|",
	`| \`432Hz Player-${version}-x64.exe\` | **推荐**：安装版（Electron 桌面应用，独立窗口 + 托盘常驻） |`,
	`| \`432Hz Player-${version}-portable.exe\` | 免安装便携版 |`,
	"| `432Hz播放器.exe` | 单文件版（自带运行时，无需安装 Node；需与 `tools\\` 放一起） |",
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
	"见仓库 README 的「下载与加速」一节（第三方镜像，仅对公开仓库有效）。",
	"",
	"### 校验",
	"",
	`- 版本：\`${version}\``,
	`- 打包时间：${new Date().toISOString()}`,
].join("\n");

const exists = (() => {
	try {
		execFileSync("gh", ["release", "view", tag, "--repo", repoName], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

if (exists) {
	note(`Release ${tag} 已存在 → 上传（覆盖同名附件）`);
	run("gh", ["release", "upload", tag, ...artifacts, "--clobber"]);
} else {
	note(`创建 Release ${tag}（${repoName}）`);
	run("gh", ["release", "create", tag, ...artifacts, "--title", `432Hz 播放器 ${tag}`, "--notes", notes]);
}

note("完成。");
try {
	const url = execFileSync("gh", ["release", "view", tag, "--repo", repoName, "--json", "url", "--jq", ".url"], { encoding: "utf8" }).trim();
	note("Release 地址：", url);
} catch {
	/* 忽略 */
}
