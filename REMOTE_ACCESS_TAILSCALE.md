# Remote access plan (Tailscale Serve) — ios-pwa-display + remo-e

## Goal

- 家の外/中どちらでも **iOS PWA のカメラ機能（= HTTPS必須）** を動かしつつ、
- remo-e の SSE（`/events`）を **mixed content なし**で購読できるようにする。

方針は **Tailscale Serve（tailnet内限定HTTPS）**。

---

## What I (Chappy) already did on this Mac

### 1) Installed Tailscale CLI via Homebrew

- ✅ `brew install tailscale` を実施（CLI/daemon バイナリは入った）
- ⚠️ `brew install --cask tailscale-app` は、macOSインストーラが `sudo` を要求し、
  このセッションではパスワード入力ができず失敗。
- ⚠️ `brew services start tailscale` は user LaunchAgent としては起動したが、
  `tailscale status` が繋がらず（root権限のdaemonが必要なため）

→ **残りは Ken の手動（管理者権限）作業が必要**。

### 2) ios-pwa-display のサーバを「PWA配信 + SSE同一オリジン化」に対応

`ios-pwa-display/server/index.ts` を更新して、以下を実装しました。

- ✅ `dist/` が存在する場合、`GET /` でPWA（ビルド成果物）を配信
- ✅ `GET /events` を **remo-e の SSE**（デフォルト `http://127.0.0.1:8787/events`）へプロキシ
  - 同一オリジン化できるので、PWA側は **SSE URL を `/events`（相対）** にできる
- ✅ 管理UIは `GET /admin` に移動（`/send`, `/status` は継続）

ローカル確認:
- `npm run build` → dist生成OK
- `npm run server` → `http://127.0.0.1:8080/` が200で返るのを確認

---

## Remaining steps (Ken manual)

### Step A) Tailscale を Mac にインストールしてログイン（管理者権限）

おすすめは **公式の Tailscale for macOS（アプリ）** を入れること。

- インストール後、Tailscaleアプリでログイン
- macOSの「Privacy & Security」で許可が求められたら許可

確認（ターミナル）:

```bash
tailscale status
```

これがエラーにならず、自分の端末一覧が出ればOK。

### Step B) ローカルで2つのプロセスを起動（localhost bind 推奨）

1) remo-e SSE

```bash
cd /Users/ai/.openclaw/workspace/remo-e

# tokenは.envや環境変数で用意（値はここに書かない）
# SSEは localhost 限定にするのが安全

go run ./cmd/remo-e-poc \
  -interval 10s \
  -http-listen 127.0.0.1:8787

Or

./scripts/remo-e-poc.sh  

```

2) ios-pwa-display (PWA配信 + /events proxy)

```bash
cd /Users/ai/.openclaw/workspace/ios-pwa-display

npm run build

# IPv6(::1)だけにbindしてしまう環境があるので、HOSTを明示する
HOST=127.0.0.1 REMOE_SSE_TARGET='http://127.0.0.1:8787/events' npm run server
# → http://127.0.0.1:8080
```

任意: remo-e SSEの転送先を変えたい場合

```bash
REMOE_SSE_TARGET='http://127.0.0.1:8787/events' npm run server
```

### Step C) Tailscale Serve で 8080 を HTTPS で公開（tailnet内）

```bash
# まず状態確認
tailscale serve status

# 8080 を tailnet向けに公開（HTTPSになる）
tailscale serve --bg 8080

# もう一度状態確認
tailscale serve status
```

**注意:** 初回に `Serve is not enabled on your tailnet` と出る場合があります。
その場合は Tailscale 管理画面で **Serve を有効化**してから、再度 `tailscale serve --bg 8080` を実行してください。

アクセスURLは通常、次の形になります:

- `https://<mac-hostname>.<tailnet>.ts.net/`
  - 例（この環境）: `https://ai.javanese-goblin.ts.net/`

（実際のホスト名/URLは `tailscale status` や `tailscale serve status` の表示に従う）

### Step D) iPhone 側

- iPhone にも Tailscale を入れて同じ tailnet に参加
- `https://<mac-hostname>.<tailnet>.ts.net/` を Safari で開く
- 「ホーム画面に追加」してPWA化

PWA内の設定:
- SSE URL は **`/events`**（相対）推奨
  - これで HTTPS → HTTPS の同一オリジンになり、mixed content を避けられる

---

## Certificate / renewal（証明書更新はどうなる？）

- `*.ts.net` のHTTPS証明書は **Tailscale側が自動取得・自動更新**する。
- 自前でACME更新ジョブ等を組む必要は基本なし。

---

## Operations / troubleshooting

### Stop / reset serve

```bash
tailscale serve reset
```

### Verify endpoints

```bash
curl -sS http://127.0.0.1:8080/status
curl -sS http://127.0.0.1:8787/healthz

# tailnet側（外から）:
# https://<...>.ts.net/status
# https://<...>.ts.net/events
```

### Notes

- Tailscaleがログアウト/停止するとHTTPS公開も止まる。
- 公開範囲は tailnet 内（＝Tailscaleに参加している端末）に限定される想定。

---

## Next nice-to-have

- launchd 等で `remo-e-poc` / `ios-pwa-display server` を常駐化
- `/events` のproxyに簡易レート制限やログを足す（必要なら）
