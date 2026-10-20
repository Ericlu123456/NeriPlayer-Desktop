//! 音频子系统 / Audio subsystem.
//!
//! `player` 是唯一持有输出流与控制线程的模块；`decoder`/`ffmpeg` 负责取样本，
//! `hls`/`remote`/`growing` 负责网络与缓冲，`dsp` 是 C++ 原生效果链，
//! `metrics` 只做原子计数，不能在音频回调里加锁或分配。
//! `player` exclusively owns the output stream and control thread; `decoder`/`ffmpeg`
//! produce samples, `hls`/`remote`/`growing` handle networking and buffering, `dsp`
//! is the native effect chain, and `metrics` is atomics-only: never lock or allocate
//! inside the audio callback.

pub mod analyzer;
pub mod buffered;
pub mod decoder;
pub mod effects;
pub mod ffmpeg;
pub mod growing;
pub mod hls;
pub mod media_session;
pub mod metrics;
pub mod pcm;
pub mod player;
pub mod quiet;
/// Sound server sinks are a Linux desktop concept; other targets keep using cpal.
#[cfg(target_os = "linux")]
pub mod system_sinks;
pub mod queue;
pub mod remote;
pub mod stretch;
pub mod dsp;
pub mod dsp_settings;
