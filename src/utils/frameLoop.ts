/**
 * One shared frame loop for the whole app.
 *
 * The now-playing page has three per-frame loops: the background shader, the lyric
 * word animation and the waveform SVG. Scheduling each of them with its own
 * `requestAnimationFrame` means three separate callbacks and three sets of start/stop
 * bookkeeping per frame, with no single place to coordinate them.
 *
 * They are merged onto a single rAF here: one dispatch runs every callback due this
 * frame, so the start/stop bookkeeping lives in one place. The API deliberately mirrors
 * `requestAnimationFrame` / `cancelAnimationFrame` so callers only swap the two function
 * names and keep their own idle-stop and restart logic.
 */

type FrameCallback = (nowMs: number) => void

/** Callbacks due in the current frame; the key is the handle returned to callers */
const pending = new Map<number, FrameCallback>()
let nextHandle = 1
let frameHandle = 0
let running = false

/** Same shape as rAF: returns a handle that `cancelFrame` accepts */
export function scheduleFrame(callback: FrameCallback): number {
  const handle = nextHandle++
  pending.set(handle, callback)
  // Never start a second rAF while the current frame is still running: callbacks that
  // re-queue themselves are picked up when this frame finishes
  if (!running && !frameHandle && typeof requestAnimationFrame === 'function') {
    frameHandle = requestAnimationFrame(runFrame)
  }
  return handle
}

/** Same shape as cancelAnimationFrame */
export function cancelFrame(handle: number): void {
  pending.delete(handle)
  if (pending.size === 0 && frameHandle && !running) {
    cancelAnimationFrame(frameHandle)
    frameHandle = 0
  }
}

function runFrame(nowMs: number): void {
  running = true
  frameHandle = 0

  // Take and remove each callback before running it, exactly like rAF: a callback runs
  // once and re-queues itself to continue, and one cancelled during this frame is
  // skipped. Callbacks added while running wait for the next frame.
  for (const handle of [...pending.keys()]) {
    const callback = pending.get(handle)
    if (!callback) continue
    pending.delete(handle)
    callback(nowMs)
  }
  running = false

  if (pending.size > 0 && !frameHandle) frameHandle = requestAnimationFrame(runFrame)
}
