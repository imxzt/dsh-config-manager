#!/usr/bin/env bash
# dcm.sh — dsh-config-manager launcher (macOS / Linux)
#
# 用法：./dcm.sh             打开外部 UI
#       ./dcm.sh health      命令行模式
#
# 自动寻找 DSH 内置 node，找不到再退回 PATH 里的 node。

set -euo pipefail

DCM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE=""

find_runtime_node() {
  local home="$1"
  [ -d "$home/dsh-runtimes" ] || return 1
  # 运行时目录名可能变化，逐个试
  for d in "$home"/dsh-runtimes/*/dependencies/node/bin/node; do
    if [ -x "$d" ]; then echo "$d"; return 0; fi
  done
  return 1
}

if [ -n "${DSH_HOME:-}" ]; then
  NODE="$(find_runtime_node "$DSH_HOME" || true)"
fi
if [ -z "$NODE" ]; then
  NODE="$(find_runtime_node "$HOME/.dsh" || true)"
fi
if [ -z "$NODE" ] && command -v node >/dev/null 2>&1; then
  NODE="node"
fi

if [ -z "$NODE" ]; then
  cat >&2 <<'EOF'

找不到 node。

本工具需要 Node.js 才能运行。三种解决办法：
  1) 确认 DSH 已安装且 DSH_HOME 指向它的主目录；
  2) 安装 Node.js (https://nodejs.org) 并加入 PATH；
  3) 手动指定：NODE=/path/to/node ./dcm.sh

EOF
  exit 1
fi

DCM="$DCM_DIR/bin/dcm.mjs"
if [ ! -f "$DCM" ]; then
  echo "找不到 $DCM —— 插件目录不完整，请重新克隆仓库。" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  exec "$NODE" "$DCM" serve --open
else
  exec "$NODE" "$DCM" "$@"
fi