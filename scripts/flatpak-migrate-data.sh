#!/usr/bin/env bash
# 在 Flatpak 与 deb/rpm 之间共用同一份用户数据（设置、歌单、缓存索引）喵。
#
# Flatpak 默认把数据放在 ~/.var/app/<app-id>/.local/share/<app-id>，和 deb/rpm 用的
# ~/.local/share/<app-id> 是两套。manifest 已经允许访问后者（xdg-data/<app-id>），
# 这里提供两种做法：
#
#   copy  （默认，推荐）：把宿主目录复制进 Flatpak 目录，一次性迁移，之后互不影响喵
#   link           ：把 Flatpak 目录软链到宿主目录，两边真正共用一份（会同时被写入）喵
#
# 用法 / Usage:
#   scripts/flatpak-migrate-data.sh            # copy
#   scripts/flatpak-migrate-data.sh link       # symlink
#   scripts/flatpak-migrate-data.sh copy --force   # 覆盖 Flatpak 侧已有数据（会先备份）

set -euo pipefail

app_id="moe.ouom.neriplayer.desktop"
mode="${1:-copy}"
force=0
[[ "${2:-}" == "--force" || "${1:-}" == "--force" ]] && force=1

host_dir="$HOME/.local/share/$app_id"
flatpak_root="$HOME/.var/app/$app_id"
flatpak_dir="$flatpak_root/.local/share/$app_id"

die() { echo "error: $*" >&2; exit 1; }

command -v flatpak >/dev/null 2>&1 || die "flatpak 未安装喵"
flatpak info "$app_id" >/dev/null 2>&1 || die "$app_id 还没安装（先 flatpak install / scripts/build-flatpak.sh）喵"

if pgrep -x neri-player-des >/dev/null 2>&1; then
  die "应用正在运行，先退出来再迁移，否则写入会打架喵"
fi

mkdir -p "$host_dir" "$(dirname "$flatpak_dir")"

case "$mode" in
  copy)
    if [[ -e "$flatpak_dir" && "$force" -ne 1 ]]; then
      echo "Flatpak 侧已有 $flatpak_dir" >&2
      echo "想用宿主目录覆盖它，加 --force（会先备份成 *.bak-<时间>）喵" >&2
      exit 1
    fi
    if [[ -e "$flatpak_dir" && "$force" -eq 1 ]]; then
      backup="$flatpak_dir.bak-$(date +%Y%m%d%H%M%S)"
      mv "$flatpak_dir" "$backup"
      echo "已备份原 Flatpak 数据到 $backup 喵"
    fi
    cp -a "$host_dir/." "$flatpak_dir/"
    echo "已把 $host_dir 复制到 $flatpak_dir 喵"
    ;;
  link)
    if [[ -L "$flatpak_dir" ]]; then
      echo "已经是软链：$(readlink "$flatpak_dir") 喵"
      exit 0
    fi
    if [[ -e "$flatpak_dir" ]]; then
      backup="$flatpak_dir.bak-$(date +%Y%m%d%H%M%S)"
      mv "$flatpak_dir" "$backup"
      echo "已备份原 Flatpak 数据到 $backup 喵"
    fi
    ln -s "$host_dir" "$flatpak_dir"
    echo "已把 $flatpak_dir 软链到 $host_dir，两边共用同一份数据喵"
    ;;
  *)
    die "未知模式：$mode（可用 copy / link）喵"
    ;;
esac

echo
echo "完成。启动：flatpak run $app_id 喵"
