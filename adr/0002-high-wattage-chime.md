# ADR-0002: High wattage chime alert (repeat while HIGH)

- Date: 2026-02-05
- Status: Accepted

## Context

家庭内のブレーカー落ち対策として、消費電力が危険域に入ったことを iOS PWA の音で即座に気づける必要がある。

- 入力: `remo-e` の SSE `PowerReadingEvent.watts`
- iOSの制約: 音再生はユーザージェスチャー後のみ有効（初回タップでunlock済み前提）
- 運用要件: しきい値は運用しながら調整したい（最初は1000W）

## Decision

### Alert state machine

- `NORMAL`: `watt < thresholdWatts`
- `HIGH`: `watt >= thresholdWatts`

遷移:
- `NORMAL -> HIGH`: 即時にチャイムを1回鳴らす + 以後 `repeatIntervalSec` ごとに繰り返し鳴らす
- `HIGH -> NORMAL`: しきい値を下回ったら停止
  - 将来の拡張として `recoveryMarginWatts` を導入し `watt < thresholdWatts - recoveryMarginWatts` で復帰可能

### Repeat behavior

- `HIGH` の間は「鳴らし続ける」= **一定間隔で繰り返しチャイム**
- v1 は `repeatIntervalSec=20` をデフォルトにする

### Safety stop (stale)

ネット断やSSE停止で HIGH のまま鳴り続ける誤警報を避けるため、
- 最後の電力イベント受信から `staleStopSec` を超えたら停止する
- SSE disconnected でも停止する

## Configuration

`public/config.json` でデフォルト値を指定する（端末ごとのUI設定で上書き可能）。

```json
{
  "alert": {
    "thresholdWatts": 1000,
    "repeatIntervalSec": 10,
    "staleStopSec": 60,
    "recoveryMarginWatts": 0
  }
}
```

## Consequences

- 危険域に入った場合、視覚に頼らず音で気づける。
- 鳴りっぱなしの誤警報は `staleStopSec` と SSE切断停止で軽減。
- 周期を短くしすぎると不快になりうるため、将来 UI で調整可能とする。
