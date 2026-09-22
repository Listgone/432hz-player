#!/usr/bin/env bash
# 用 Windows 自带的 csc.exe 编译 tools/ 下的两个 C# 工具（零安装依赖）。
# 仓库里已带编译好的 exe；只有改了 .cs 才需要重新跑。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CSC="${CSC:-/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe}"

echo "[build] app dir: $DIR"

if [ ! -f "$CSC" ]; then
  echo "[build] csc.exe not found at $CSC" >&2
  echo "[build] 需要 .NET Framework 4.x（Windows 自带）。已存在的 exe 仍可继续使用。" >&2
  exit 1
fi

for name in AudioEndpoint AudioRender; do
  SRC="$DIR/tools/$name.cs"
  OUT="$DIR/tools/$name.exe"
  [ -f "$SRC" ] || { echo "[build] missing $SRC" >&2; exit 1; }
  echo "[build] compiling $name"
  "$CSC" /nologo /optimize+ /platform:x64 /out:"$(cygpath -w "$OUT")" "$(cygpath -w "$SRC")"
  [ -f "$OUT" ] || { echo "[build] FAILED: $OUT" >&2; exit 1; }
done

echo "[build] ok"
