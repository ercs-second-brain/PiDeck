# Terminal bridge performance (issue #67)

How the WebSocket ⇄ tmux bridge moves bytes (apps/daemon/src/terminal/),
what changed for #67, and how to measure it.

## Input path: coalesced keystrokes

Per-streamer `InputPump` (`input-pump.ts`) accumulates keystrokes and
flushes them as few, large `send-keys -H` invocations:

- an 8ms macrotask flush window (`inputFlushMs`) batches a typing burst;
- keystrokes that arrive while a `send-keys` batch is already in flight
  are drained into the next batch;
- payloads are chunked at 4KB per invocation (`inputChunkBytes`);
- the output capture is poked once per flush, not once per keystroke.

The web client helps too: `apps/web/src/terminal/input-batcher.ts` merges
the per-key `onData` events xterm.js emits into one WebSocket frame per
event-loop tick (boundary keys like Enter flush early).

## Output path: event-driven, screen-only captures

`PaneEventSource` (event-source.ts) starts `tmux pipe-pane -o
'cat >> <stream file>'` for the pane and watches the stream file with
`fs.watch`. Every pane-output byte appends to the file with sub-millisecond
latency, so the bridge captures within milliseconds of any output — no
poll interval in the latency path. The stream file's content is ignored
(only "it grew" matters); it is truncated when it exceeds 512KB, and the
directory is removed when the last client detaches.

Captures are screen-only (`capture-pane -p -e -S -<rows>`), O(rows)
instead of O(full scrollback). The full scrollback is captured exactly
once, for the replay on attach/reconnect — replay, resize, multi-client
broadcast, and `terminal.exited` semantics are unchanged.

If the event source cannot arm (no `fs.watch` support, stream file never
appears), the bridge falls back to the adaptive timer loop (50ms active /
250ms idle); while the stream is healthy that timer only runs as a 500ms
safety net (`streamPollMs`).

## Cursor synchronization (issue #92)

`capture-pane` output has no notion of the pane cursor, and full-screen
TUIs (like pi) hide the real cursor and paint their own — while the diff
protocol's row rewrites leave the client cursor wherever the last
rewritten row ended. Without explicit sync, xterm.js therefore draws its
own blinking cursor at arbitrary spots on top of the pane's real one.

Every content frame (and the attach/reconnect replay) ends with the
pane's true cursor state, read whenever a frame is broadcast via
`tmux display-message -p '#{cursor_flag}|#{cursor_x}|#{cursor_y}'`:
hide (`ESC[?25l`) or show + absolute CUP, emitted only when the state
changed.

## Benchmark

```
pnpm --filter @agentskiss/daemon bench:terminal
```

Runs `apps/daemon/src/terminal/bench.ts` against the fake tmux runner:

- **coalescing** — 300 keystrokes at ~200/s: counts `send-keys`
  invocations (legacy design: one per keystroke) and echo latency
  (keystroke → broadcast frame). Measured (fake tmux, 5ms keystroke
  spacing): 150 invocations, echo p50 ≈ 8ms / max ≈ 9ms. Legacy: 300
  invocations, echo bound by the 50ms poll + a full-scrollback capture
  fork (~11ms with a populated 2000-line history).
- **captures** — 200 pane writes in 1s: 21 event-driven captures
  (write bursts merge), ~6KB per capture vs ~10KB for a full-scrollback
  capture — and the legacy design captures that volume every 50ms while
  active (and every 250ms while idle), where the new design only wakes
  on output.
