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

## 构建

```bash
scripts/build-flatpak.sh              # 构建并装到当前用户
scripts/build-flatpak.sh --no-install # 只构建
RUNTIME_BRANCH=50 scripts/build-flatpak.sh
```

脚本会先检查工具与运行时是否齐备，缺什么打印对应安装命令，不会自己调 `sudo`。

## 为什么选这个 runtime 分支

`org.gnome.Platform` 自带 WebKitGTK，所以 runtime 分支直接决定 WebKit 版本。
WebKitGTK 2.54 换了 web 进程合成器（Skia + damage-aware compositing），带进了一个
透明度/背景刷新时的间歇闪烁回归（上游 [WebKit Bug 327524](https://bugs.webkit.org/show_bug.cgi?id=327524)，
2.54.2 仍未修复）。选一个 WebKit < 2.54 的分支可以同时避开它。

先确认分支里到底是什么版本，再决定用哪个分支：

```bash
flatpak run --command=sh org.gnome.Platform//49 -c \
  'pkg-config --modversion webkit2gtk-4.1; ldd --version | head -1'
```

## 已知取舍

- **runtime 体积**：首次安装要拉 1GB 量级（runtime + GL 驱动），换来的是一致环境。
- **安全更新跟随 runtime 分支**：分支 EOL 后 WebKit 不再更新。旧引擎对本项目风险相对低
  （只渲染自家 UI，不加载第三方网页），但仍有图片解码等攻击面，分支需要定期跟进。
- **本地文件**：原型用 `--filesystem=home` 让曲库与下载可用；正式提审建议改成
  portal 或具体目录（`--filesystem=xdg-music`、`--filesystem=xdg-download`）。
- **托盘**：`libayatana-appindicator` 在沙箱里可用，但 GNOME 桌面需要 AppIndicator 扩展。
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
