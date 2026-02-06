# iOS PWA Display

iOS Safari 上でPWAとして動作する常時表示ディスプレイアプリ。

## 機能

- **自動スリープ禁止** — NoSleep.js で画面が消えないように
- **周囲明るさ推定** — フロントカメラで環境光を検出、画面の明るさ/配色を自動調整
- **WebSocket メッセージ受信** — サーバーからのメッセージで画面表示を変更
- **SSE 電力データ受信（remo-e）** — `power.reading` を SSE で購読して瞬時電力(W)を表示
- **音声通知** — メッセージ受信/閾値超過時にサウンド再生

## セットアップ

環境構築/運用手順（macOS + iOS + Tailscale Serve）: **[SETUP.md](./SETUP.md)**

```bash
# 依存関係インストール
npm install

# 開発サーバー起動（フロントエンド）
npm run dev

# WebSocket サーバー起動（別ターミナル / 任意）
npm run server

# remo-e を用意できない時の動作確認用: モックSSEサーバー（別ターミナル）
npm run mock:sse
```

## 使い方

### 1. フロントエンドにアクセス

```
http://localhost:3000
```

### 2. WebSocket / SSE URL を設定

画面長押し（またはPC右クリック）で設定パネルを開き、URLを入力:

- WebSocket URL（任意・画面メッセージ用）

```
ws://localhost:8080
```

- SSE URL（必須・電力表示用 / remo-e 側）

```
http://<mac-ip>:8787/events
```

### 3. メッセージを送信

```bash
# テキストメッセージ
curl -X POST http://localhost:8080/send \
  -H "Content-Type: application/json" \
  -d '{"type":"text","content":"Hello!","sound":"default"}'

# アラート
curl -X POST http://localhost:8080/send \
  -H "Content-Type: application/json" \
  -d '{"type":"alert","title":"警告","body":"これはアラートです","sound":"alert"}'

# 画面クリア
curl -X POST http://localhost:8080/send \
  -H "Content-Type: application/json" \
  -d '{"type":"clear"}'
```

### 4. サーバー Web UI

- `http://localhost:8080/admin` を開くと、簡易送信UIが使える。
- `dist/`（ビルド成果物）がある場合は `http://localhost:8080/` でPWAも配信される。

## 電力(SSE)インターフェース（合意済み）

PWA は remo-e の SSE を購読します。

- 推奨（同一オリジン）: `GET http://localhost:8080/events`（サーバが remo-e をプロキシ）
- 直接購読する場合: `GET http://<mac-ip>:8787/events`
- Content-Type: `text/event-stream`
- Event name: `message`
- Payload:

```ts
export interface PowerReadingEvent {
  type: 'power.reading';
  timestamp: string;  // ISO8601 (RFC3339)
  watts: number;      // W
  applianceId: string;
  nickname: string;
  sourceHost?: string;
}
```

詳細: `DESIGN.md` を参照。

## メッセージ形式（WebSocket）

```typescript
interface DisplayMessage {
  type: 'text' | 'image' | 'alert' | 'clear';
  content?: string;        // type: text
  imageUrl?: string;       // type: image
  title?: string;          // type: alert
  body?: string;           // type: alert
  style?: {
    backgroundColor?: string;
    textColor?: string;
    fontSize?: 'small' | 'medium' | 'large' | 'xlarge';
  };
  sound?: 'none' | 'default' | 'alert' | 'chime';
  duration?: number;       // ms, 0 = 永続
}
```

## iOS でPWAとしてインストール

1. Safari で開く
2. 共有ボタン → 「ホーム画面に追加」
3. ホーム画面から起動するとフルスクリーンで動作

## 設定ファイル（config.json）

PWAの挙動（明るさの閾値、文字色の最小/最大など）は `public/config.json` で指定できます。

- `brightness.minThreshold`: この値以下は 0% 扱い
- `brightness.maxThreshold`: この値以上は 100% 扱い
- `textColor.min`: 暗いときの文字色
- `textColor.max`: 明るいときの文字色
- `alert.thresholdWatts`: これ以上で危険域（HIGH）
- `alert.repeatIntervalSec`: HIGHの間、この秒数ごとにチャイムを鳴らす
- `alert.staleStopSec`: 電力イベントがこの秒数以上来ない場合は誤警報防止のため停止
- `alert.recoveryMarginWatts`: 復帰マージン（`watt < threshold - margin` で復帰）
- `alert.announce.enabled`: HIGH中にアナウンスを行う
- `alert.announce.mode`: `audio`（音声ファイル）または `speech`（Web Speech API）
- `alert.announce.soundName`: `audio` モードで再生するサウンド名（例: `voice_high_wattage_ja`）
- `alert.announce.message`: `speech` モードの文言

`config.json` は `Service Worker` にキャッシュされないため、値を調整してリロードすると反映されます。

## 本番デプロイ

### HTTPS が必要

カメラアクセスには HTTPS が必要。以下のいずれかを使用:

- **ngrok**: `ngrok http 3000`
- **Cloudflare Tunnel**
- **Let's Encrypt** + リバースプロキシ

### ビルド

```bash
npm run build
# dist/ にビルド結果が出力される
```

## ディレクトリ構成

```
ios-pwa-display/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── public/
│   ├── manifest.json
│   ├── sw.js
│   └── icons/
├── scripts/
│   └── mock-sse-server.ts
├── src/
│   ├── main.ts
│   ├── controllers/
│   │   └── display-controller.ts
│   ├── services/
│   │   ├── nosleep-manager.ts
│   │   ├── brightness-detector.ts
│   │   ├── message-client.ts
│   │   ├── sse-client.ts
│   │   └── sound-manager.ts
│   └── styles/
│       └── main.css
└── server/
    └── index.ts
```

## 制約

- **ユーザージェスチャー必須**: スリープ防止・カメラ・音声は初回タップ後に有効化
- **バックグラウンド不可**: WebSocket はバックグラウンドで切断される（フォアグラウンド専用）
- **HTTPS必須**: カメラアクセスには HTTPS が必要（localhost は例外）

