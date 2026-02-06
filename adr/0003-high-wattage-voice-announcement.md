# ADR-0003: Voice announcement for high wattage alert

- Date: 2026-02-05
- Status: Accepted

## Context

高負荷（ブレーカーが落ちそう）状態の通知音（チャイム）が気づきづらい。
高級家電のように短い音声で行動を促したい。

要求:
- HIGH（`watt >= threshold`）の間は通知を繰り返す（repeat interval は 10 秒）
- 文言は以下（固定）:
  - 「消費電力が高くなっています。不要な家電の運転を停止してください。」

## Decision

- HIGH alert の通知方法として、iOS PWA の `speechSynthesis` を使った音声アナウンスを追加する。
- `alert.announce.enabled=true` の場合:
  - HIGH への遷移時に 1 回アナウンス
  - HIGH 継続中は `repeatIntervalSec` ごとにアナウンスを繰り返す
- アナウンスが重複しないように、`speechSynthesis.speaking/pending` 中はスキップする。

## Configuration

`public/config.json`:

```json
{
  "alert": {
    "announce": {
      "enabled": true,
      "message": "消費電力が高くなっています。不要な家電の運転を停止してください。"
    }
  }
}
```

## Consequences

- 音声で行動を促せるため、気づきやすさが上がる。
- iOS の制約として、初回ユーザー操作後にのみ音声が出る（アプリ初期化タップで満たす想定）。
