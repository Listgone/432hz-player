// 校验 web/index.html 内联脚本的语法（不需要浏览器）
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync("D:/dsh432/432hz-player/web/index.html", "utf8");
const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (matches.length === 0) {
	console.error("未找到内联脚本");
	process.exit(1);
}
let bad = 0;
matches.forEach((m, i) => {
	const code = m[1];
	const tmp = `D:/dsh432/432hz-player/build/_check_${i}.cjs`;
	writeFileSync(tmp, code, "utf8");
	try {
		new Function(code);
		console.log(`script[${i}] 语法 OK（${code.length} 字符）`);
	} catch (error) {
		bad += 1;
		console.error(`script[${i}] 语法错误: ${error.message}`);
	}
});
// 顺便检查 data-i18n 键是否都在字典里
const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
const zhBlock = html.slice(html.indexOf("const I18N"), html.indexOf("let LANG"));
const missing = keys.filter((k) => !zhBlock.includes(`"${k}"`));
console.log(`data-i18n 键 ${keys.length} 个，字典缺失 ${missing.length} 个${missing.length ? `: ${missing.join(", ")}` : ""}`);
process.exit(bad === 0 ? 0 : 1);
