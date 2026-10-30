# Flatpak 打包（原型）

Linux 端的两类不稳定都来自「运行环境不固定」：glibc 由构建机决定，WebKitGTK 由发行版决定。
Flatpak 用固定 runtime 同时解决这两点——glibc 和 `libwebkit2gtk-4.1` 都来自 runtime，
而不是宿主机。

当前是**原型**，还没在 CI 上跑过，也没提交 Flathub。

## 前置条件

```bash
# 构建工具
sudo pacman -S flatpak flatpak-builder        # Fedora: dnf install flatpak flatpak-builder

# runtime / SDK / 扩展（分支要和 manifest 里的 runtime-version 一致）
flatpak install flathub org.gnome.Platform//49 org.gnome.Sdk//49 \
  org.freedesktop.Sdk.Extension.rust-stable//25.08 \
  org.freedesktop.Sdk.Extension.node22//25.08
```

## 前置：生成离线 crate 源

沙箱里拉 crates.io 索引又慢又容易超时，所以构建走本地 vendor（体积约 1.5G，已 gitignore，
不入库）；缺了它构建会在 `pnpm tauri build` 阶段失败：

```bash
cd src-tauri && cargo vendor --locked ../flatpak/cargo-vendor
```

`scripts/build-flatpak.sh` 会先检查这个目录，缺失时直接给出上面这条命令喵。

## 可选：随包带 FFmpeg

`org.gnome.Platform` 不自带 FFmpeg（Flathub 上也没有可用的 `ffmpeg-full` 扩展），所以默认会回退到
内置解码器。要带完整解码链路，把 CI 的 FFmpeg 产物放到 `flatpak/ffmpeg-prebuilt/`（已 gitignore），
构建时会复制到 `/app/bin/ffmpeg`，也就是应用的第一搜索路径之一：

```bash
# 从 FFmpeg 工作流下载（产物名 ffmpeg-linux-x86_64）
gh run download --repo cwuom/NeriPlayer-Desktop \
  --name ffmpeg-linux-x86_64 --dir flatpak/ffmpeg-prebuilt
```

注意事项：

- 产物必须在**老 glibc** 上构建（CI 的 ubuntu-22.04，glibc 2.35）才能在本 runtime 里加载；
  直接拷宿主机的 `libav*` 会因为 glibc 版本更高而失败喵。
- **自建仓库/手工分发允许打包预编译二进制**；提交 Flathub 时必须改成源码模块（`scripts/ffmpeg/build-ffmpeg.sh`
  作为 flatpak module），否则审查会拒绝喵。

## 构建

```bash
scripts/build-flatpak.sh              # 构建并装到当前用户
scripts/build-flatpak.sh --no-install # 只构建
RUNTIME_BRANCH=48 scripts/build-flatpak.sh
```

脚本会先检查工具与运行时是否齐备，缺什么打印对应安装命令，不会自己调 `sudo`。

## 为什么选这个 runtime 分支

`org.gnome.Platform` 自带 WebKitGTK，所以 **runtime 分支直接决定 WebKit 版本**，而这就是本清单
固定 48 的原因：

| 分支 | WebKitGTK | 动态背景 / 切页闪烁 |
| --- | --- | --- |
| 48 | `libwebkit2gtk-4.1.so.0.19.9`（2.46/2.48） | 实测不闪（动画、动态背景都正常） |
| 49 | `libwebkit2gtk-4.1.so.0.24.3`（2.54 一代） | 会闪，上游 [WebKit 327524](https://bugs.webkit.org/show_bug.cgi?id=327524)，2.54.2 未修 |

升级分支前先确认里面的 WebKit 版本，否则会把闪烁带回来：

```bash
flatpak run --command=sh org.gnome.Platform//48 -c \
  'ls /usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0.*'
```

## 从 deb / rpm 迁移到 Flatpak

三种做法，按「要不要继续和旧安装共用一份数据」选喵：

**A. 应用内备份（最稳，跨打包方式都适用）**

旧版本里：**设置 → 备份** 导出配置；装好 Flatpak 后在同一位置导入喵。
歌单、设置、统计都走这份导出，不依赖文件路径，是唯一推荐给普通用户的方式喵。

**B. 复制数据目录（一次性迁移）**

```bash
sudo pacman -Rns neri-player-desktop   # 先卸掉旧包，避免两个版本抢单实例
scripts/flatpak-migrate-data.sh        # 把 ~/.local/share/moe.ouom.neriplayer.desktop 复制进 Flatpak
flatpak run moe.ouom.neriplayer.desktop
```

复制后两份数据各自独立，之后互不影响；想回滚只需重装 deb/rpm 喵。

**C. 软链共用（两边同一份配置）**

```bash
scripts/flatpak-migrate-data.sh link
```

`~/.var/app/moe.ouom.neriplayer.desktop/.local/share/moe.ouom.neriplayer.desktop`
会指向宿主目录，deb/rpm 与 Flatpak 读写同一份数据喵。**不要两边同时运行**，单实例锁不跨沙箱喵。

> 迁移前先退出应用；脚本会检查进程。缓存目录（封面、音频缓存）也在这份数据里，
> 想省时间可以迁移后删掉 `cache/` 让它重建喵。

## 数据目录与迁移

Flatpak 默认把数据放在 `~/.var/app/moe.ouom.neriplayer.desktop/`，和 deb/rpm 用的
`~/.local/share/moe.ouom.neriplayer.desktop` 是两套。manifest 已经放开后者
（`--filesystem=xdg-data/moe.ouom.neriplayer.desktop:create`），用脚本二选一：

```bash
scripts/flatpak-migrate-data.sh        # 复制宿主数据进 Flatpak（一次性迁移，推荐）
scripts/flatpak-migrate-data.sh link   # 软链到宿主目录，两边真正共用一份
```

迁移前要先退出应用，脚本会检查喵。

## 已知取舍

- **runtime 体积**：首次安装要拉 1GB 量级（runtime + GL 驱动），换来的是一致环境。
- **安全更新跟随 runtime 分支**：分支 EOL 后 WebKit 不再更新。旧引擎对本项目风险相对低
  （只渲染自家 UI，不加载第三方网页），但仍有图片解码等攻击面，分支需要定期跟进。
- **本地文件**：原型用 `--filesystem=home` 让曲库与下载可用；正式提审建议改成
  portal 或具体目录（`--filesystem=xdg-music`、`--filesystem=xdg-download`）。
- **托盘**：`libayatana-appindicator` 由 manifest 里的 shared module 提供；Tauri 会把图标写成
  临时 PNG 并把路径当 `IconName` 传出去，所以还需要 `--filesystem=xdg-run/tray-icon`，
  否则托盘能创建但图标是空的（沙箱里 `/run/user/$UID` 是私有 tmpfs）喵。
  GNOME 桌面仍需要 AppIndicator 扩展才显示托盘喵。
- **网络**：沙箱需要显式 `--share=network`，否则应用完全连不上网喵。
- **全局快捷键**：沙箱内注册全局快捷键受限，媒体键仍走 MPRIS。

## 提交流程（Flathub 需要离线构建）

Flathub 的构建环境**没有网络**，所以现场 `pnpm install` / 拉 crates 会因为拿不到网而失败。
提交前需要生成并提交两个 sources 文件：

```bash
# Node 依赖（pnpm）
pipx install flatpak-node-generator
flatpak-node-generator --no-requests-cache -o flatpak/node-sources.json pnpm pnpm-lock.yaml

# Rust crates
python3 flatpak-cargo-generator.py -o flatpak/cargo-sources.json src-tauri/Cargo.lock
```

然后把它们加进 manifest 的 `sources`，并把 `pnpm install` 改成离线模式（`--offline`），
`pnpm tauri build` 也要带上 `--offline`/`CARGO_NET_OFFLINE=1`。

## 还没做的部分

- 没有 CI 任务（先本地跑通，再决定是否进 `release.yml` 矩阵）；
- 没有在 Fedora / Debian 上实测安装；
- 搜索顺序：应用 ID 需要和桌面文件、metainfo、`StartupWMClass` 保持一致
  （`moe.ouom.neriplayer.desktop`）。
