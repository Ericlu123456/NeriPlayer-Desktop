# FFmpeg 垫片

`neri_ffmpeg.cpp` 由 `build.rs` 用 `cc` 编进程序，运行时从指定目录加载 FFmpeg 动态库
（Windows：`avutil-61.dll`、`avcodec-63.dll`、`avformat-63.dll`），找不到或版本不符时
返回原因，播放器回退到 symphonia。Rust 侧只通过这里导出的 C 接口访问 FFmpeg。

## 动态库位置

依次查找：环境变量 `NERI_FFMPEG_DIR`、可执行文件旁的 `ffmpeg/` 与可执行文件所在目录
（macOS 另查 `../Frameworks`、`../Resources/ffmpeg`，Linux 另查 `../lib/neri-player-desktop`）。
调试构建最后还会找 `.cache/ffmpeg/<os>-<arch>/bin`（Windows）或 `lib`，开发机把同一主版本的
FFmpeg 共享库放在那里即可；`NERI_REQUIRE_FFMPEG=1` 时测试找不到动态库会失败而不是跳过。

## 头文件

`include/` 是垫片实际用到的 32 个 FFmpeg 公共头文件，取自 FFmpeg n9.0.2-22-g46d8f462ee
（libavutil 61.1.102、libavcodec 63.1.102、libavformat 63.1.102）。它们只决定编译期的
结构体布局与函数签名；每个文件按其文件头声明以 LGPL-2.1-or-later 授权。

运行时要求同一主版本、次版本不低于这里的头文件，`neri_ff_load` 会校验。

## 更新头文件

1. 取新版本完整的 `include/` 目录；
2. 用 MSVC 加 `/showIncludes` 编译 `neri_ffmpeg.cpp`，列出其中位于该目录下的头文件；
3. 用这份清单替换 `include/` 下的文件，并更新上面的版本号；主版本变化时同步改 Rust 侧的说明与测试。
