#!/usr/bin/env bash
# 构建 NeriPlayer 的 Flatpak 包（原型）喵。
#
# 这个脚本只负责「把前置条件检查清楚 + 跑 flatpak-builder」，不做任何需要 sudo 的安装，
# 缺什么就打印出该执行的命令让你自己决定喵。
#
# 用法 / Usage:
#   scripts/build-flatpak.sh            # 构建并安装到当前用户
#   scripts/build-flatpak.sh --no-install
#   RUNTIME_BRANCH=49 scripts/build-flatpak.sh   # 试别的 runtime 分支（默认取清单里的值）
#
# 想验证 runtime 里实际是哪个 WebKitGTK / glibc 喵：
#   flatpak run --command=sh org.gnome.Platform//49 -c \
#     'pkg-config --modversion webkit2gtk-4.1; ldd --version | head -1'

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$repo_root/flatpak/moe.ouom.neriplayer.desktop.yml"
# runtime 分支以清单为准，避免脚本和 manifest 各说各话喵
runtime_branch="${RUNTIME_BRANCH:-$(sed -n "s/^runtime-version: *'\([^']*\)'.*/\1/p" "$repo_root/flatpak/moe.ouom.neriplayer.desktop.yml" | head -1)}"
runtime_branch="${runtime_branch:-48}"
build_dir="${BUILD_DIR:-$repo_root/flatpak/build-dir}"
state_dir="${STATE_DIR:-$repo_root/flatpak/.flatpak-builder}"
install=1

for arg in "$@"; do
  case "$arg" in
    --no-install) install=0 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

# flatpak-builder 会在 state dir 里为每条 build command 存快照，Tauri 这种「前端依赖 +
# Rust release 构建」的体量很容易把磁盘吃掉（实测一次 81G），所以先看空间再动手喵
free_gib=$(df -BG --output=avail "$repo_root" | tail -1 | tr -dc '0-9')
min_gib="${MIN_FREE_GIB:-20}"
if (( free_gib < min_gib )); then
  die "磁盘剩余 ${free_gib}G，低于 $min_gib G；先清空间（可删 flatpak/.flatpak-builder）或设 MIN_FREE_GIB 覆盖"
fi
echo "==> 剩余空间 ${free_gib}G，开始构建喵"

[[ -f "$manifest" ]] || die "manifest not found: $manifest"
# cargo vendor 目录是构建必需品，但体积大、不入库：先生成再构建喵
if [[ ! -d "$repo_root/flatpak/cargo-vendor" ]]; then
  cat >&2 <<'EOF'
error: 缺少 flatpak/cargo-vendor（离线构建用的 crate 源）喵。先生成：
  (cd src-tauri && cargo vendor --locked ../flatpak/cargo-vendor)
EOF
  exit 1
fi

command -v flatpak >/dev/null 2>&1 || die "flatpak 未安装（Arch: sudo pacman -S flatpak）"
if ! command -v flatpak-builder >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: flatpak-builder 未安装喵。按发行版装一个：
  Arch:      sudo pacman -S flatpak-builder
  Fedora:    sudo dnf install flatpak-builder
  Debian:    sudo apt install flatpak-builder
EOF
  exit 1
fi

# runtime / sdk / 扩展缺了就提示，不代替你 sudo 喵
missing=0
require_ref() {
  local ref="$1"
  if ! flatpak info "$ref" >/dev/null 2>&1; then
    echo "缺少: $ref" >&2
    missing=1
  fi
}
require_ref "org.gnome.Platform//$runtime_branch"
require_ref "org.gnome.Sdk//$runtime_branch"
# 扩展分支跟随 freedesktop-sdk（GNOME 48 → 24.08），不跟随 GNOME 分支喵
sdk_branch="${SDK_BRANCH:-24.08}"
require_ref "org.freedesktop.Sdk.Extension.rust-stable//$sdk_branch"
require_ref "org.freedesktop.Sdk.Extension.node22//$sdk_branch"

if [[ "$missing" -ne 0 ]]; then
  cat >&2 <<EOF

先安装缺的运行时喵：
  flatpak install flathub org.gnome.Platform//$runtime_branch org.gnome.Sdk//$runtime_branch \\
    org.freedesktop.Sdk.Extension.rust-stable//$sdk_branch \\
    org.freedesktop.Sdk.Extension.node22//$sdk_branch

如果 node22 扩展在 $sdk_branch 上不存在，换成 org.freedesktop.Sdk.Extension.node20 喵。
EOF
  exit 1
fi

# flatpak-builder 的构建沙箱默认允许联网；原型阶段依赖 pnpm 现场安装，所以这里不额外限制喵
# 正式提交流程需要把 node-sources.json / cargo-sources.json 生成并提交，见 flatpak/README.md
builder_args=(
  --user
  --force-clean
  # 交互式构建里 rofiles-fuse 经常在中断后留下坏掉的挂载点，接着报 Permission denied；
  # 它只是加速用的，直接关掉更省事喵
  --disable-rofiles-fuse
  --state-dir="$state_dir"
)
# 默认不存快照（体积大）；调试期间想复用中间结果就设 KEEP_CACHE=1喵
if [[ "${KEEP_CACHE:-0}" != "1" ]]; then
  builder_args+=(--disable-cache)
fi
if [[ "$install" -eq 1 ]]; then
  builder_args+=(--install)
fi

echo "==> flatpak-builder（runtime $runtime_branch）喵"
flatpak-builder "${builder_args[@]}" "$build_dir" "$manifest"

# 中间目录默认删掉，只留最终的 flatpak 包；要复用就设 KEEP_CACHE=1喵
if [[ "${KEEP_CACHE:-0}" != "1" ]]; then
  rm -rf "$build_dir" "$state_dir"
fi

if [[ "$install" -eq 1 ]]; then
  echo
  echo "已安装，运行方式喵： flatpak run moe.ouom.neriplayer.desktop"
else
  echo
  echo "构建产物在 $build_dir，可用 flatpak-builder --repo 导出喵"
fi
