// Electron 预加载脚本：只暴露极小的安全接口（contextIsolation 下唯一通道）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
	/** 是否是桌面（Electron）外壳运行 —— 界面据此显示「收进托盘」等桌面专属提示 */
	isDesktop: true,
	platform: process.platform,
	/** 打开 %USERPROFILE%\.432hz-player */
	openDataDir: () => ipcRenderer.invoke("open-data-dir"),
	/** 退出应用（连同音频服务） */
	quit: () => ipcRenderer.invoke("quit"),
});
