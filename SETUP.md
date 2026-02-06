# Setup / Environment build guide (macOS + iOS + Tailscale)

このプロジェクト（`ios-pwa-display`）は iOS Safari/PWA で常時表示するディスプレイUIです。

- 画面側（iPhone）は **HTTPS** で開く必要があります（カメラ/明るさ推定のため）
- 電力データは `remo-e` の **SSE** を購読します
- 家の外/中どちらでも安全に見るために **Tailscale Serve（tailnet内限定HTTPS）** を推奨します

---

## 0. 必要なもの

### ハード/アカウント

- iPhone（PWAを表示する端末）
- macOS（サーバ + remo-e を動かす端末）
- Tailscale アカウント（tailnet）
- Nature Cloud API トークン（`REMOE_TOKEN`）

### ソフトウェア（macOS）

- Node.js（npm含む）
- Tailscale（macOSアプリ推奨）

---

## 1. リポジトリ準備

```bash
git clone <this-repo>
cd ios-pwa-display
npm install
```

---

## 2. ローカル開発（UIだけ動作確認）

### 2.1 フロントエンド開発サーバ

```bash
npm run dev
# -> http://localhost:3000
```

### 2.2 remo-e が無い場合（モックSSE）

```bash
npm run mock:sse
```

PWAの設定で SSE URL を以下にすると動作確認できます：

- SSE URL: `http://localhost:8787/events`（モック側のポートに合わせて）

---

## 3. 本番運用（推奨構成）

本番では **`npm run server`（8080）** が「PWA配信 + `/events` を remo-e SSE にプロキシ」を担当します。
PWA側は **SSE URL を `/events`（相対）** にすることで、HTTPS環境でも mixed content を避けられます。

### 3.1 remo-e（SSE供給）を起動

別プロジェクト `remo-e` を起動します（SSEを localhost に出すのが安全）。

例（`go run`）:

```bash
cd /path/to/remo-e

# REMOE_TOKEN を環境変数か .env で用意（値はコミットしない）
export REMOE_TOKEN="..."

go run ./cmd/remo-e-poc \
  -interval 10s \
  -http-listen 127.0.0.1:8787
```

`.env` を使う場合は `remo-e` の `scripts/remo-e-poc.sh` が読み込みます。

確認:

```bash
curl -sS http://127.0.0.1:8787/healthz
curl -sS -N -H 'Accept: text/event-stream' --max-time 2 http://127.0.0.1:8787/events | head
```

### 3.2 ios-pwa-display（PWA配信 + SSEプロキシ）を起動

```bash
cd ios-pwa-display

npm run build

# IPv6(::1)だけにbindしてしまう環境があるので HOST を明示
HOST=127.0.0.1 REMOE_SSE_TARGET='http://127.0.0.1:8787/events' npm run server
# -> http://127.0.0.1:8080
```

確認:

```bash
curl -sS http://127.0.0.1:8080/status
curl -sS -N -H 'Accept: text/event-stream' --max-time 2 http://127.0.0.1:8080/events | head
```

---

## 4. Tailscale Serve（tailnet内限定HTTPS）

### 4.1 Tailscaleにログイン

- macOSのTailscaleアプリでログイン
- iPhoneにもTailscaleを入れて同じtailnetに参加

確認（macOS）:

```bash
tailscale status
```

### 4.2 Serve を有効化して 8080 を公開

```bash
tailscale serve status

# 8080 をHTTPSで公開（tailnet内限定）
tailscale serve --bg 8080

tailscale serve status
```

`serve status` に出てくるURL（例: `https://<host>.<tailnet>.ts.net/`）が PWA のURLです。

---

## 5. iPhone（PWAとして利用）

1. iPhoneで Tailscale を接続
2. Safariで `https://<host>.<tailnet>.ts.net/` を開く
3. 共有 → 「ホーム画面に追加」
4. PWAを開き、初回タップで初期化（スリープ防止/音/カメラ権限）
5. 設定（長押し）
   - SSE URL: **`/events`**（推奨）
   - WebSocket URL: 任意（使う場合のみ）

---

## 6. 明るさ判定の閾値 & 文字色（config.json）

`public/config.json` で調整できます。

```json
{
  "brightness": {
    "minThreshold": 0.2,
    "maxThreshold": 0.5
  },
  "textColor": {
    "min": "#374151",
    "max": "#ffffff"
  }
}
```

- `minThreshold` 以下 → 0%
- `maxThreshold` 以上 → 100%
- `textColor.min`（暗いとき）〜 `textColor.max`（明るいとき）を線形補間

変更したら基本は:

```bash
npm run build
```

その後iPhoneでリロード。

---

## 7. トラブルシュート

### PWAが開けない

- iPhoneのTailscaleが **接続** しているか
- macOSで `tailscale serve status` が設定されているか
- ローカルの `ios-pwa-display server` が生きているか

```bash
curl -sS http://127.0.0.1:8080/status
```

### ずっと「待機中…」

- SSEが届いていない状態です。
- PWAの SSE URL が `http://<lan-ip>:8787/events` のような直接URLだと、HTTPSでは mixed content になりがち。
  - **`/events`** を推奨。

### カメラ（明るさ推定）が動かない

- iOSはHTTPS必須（`localhost` 例外以外の `http://` はNG）
- Tailscale Serve のURL（`https://...ts.net/`）で開いているか
