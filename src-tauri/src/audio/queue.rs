use crate::state::RepeatMode;

/// 后端播放队列状态镜像
///
/// 队列推进完全由前端 player.ts 负责，后端只保存 repeat/shuffle 这两个字段，
/// 供 `get_player_state` 与 `cycle_repeat` 读写。
pub struct PlayQueue {
    pub repeat_mode: RepeatMode,
    pub shuffle: bool,
}

impl Default for PlayQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl PlayQueue {
    pub fn new() -> Self {
        Self {
            repeat_mode: RepeatMode::Off,
            shuffle: false,
        }
    }

    pub fn cycle_repeat(&mut self) -> RepeatMode {
        self.repeat_mode = match self.repeat_mode {
            RepeatMode::Off => RepeatMode::All,
            RepeatMode::All => RepeatMode::One,
            RepeatMode::One => RepeatMode::Off,
        };
        self.repeat_mode
    }
}
