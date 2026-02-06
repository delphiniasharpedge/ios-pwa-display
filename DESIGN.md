# iOS PWA ディスプレイアプリ — 設計書

## 1. 概要

iOS Safari上でPWAとして動作する常時表示ディスプレイアプリ。外部からのメッセージに応じて画面表示を変化させ、周囲の明るさに応じて自動調整する。

---

## 2. 要件

| 要件 | 説明 |
|------|------|
| **自動スリープ禁止** | 画面が消えないようにする |
| **周囲明るさ推定** | カメラ等で環境光を推定し、画面の明るさ/配色を調整 |
| **メッセージ受信** | WebSocket/SSE/ポーリングでメッセージを受け取り表示を変更 |
| **音声通知** | メッセージ受信時にサウンドを再生 |

---

## 3. 技術的制約（iOS Safari / PWA）

### 3.1 自動スリープ禁止

| 方法 | iOS対応 | 備考 |
|------|---------|------|
| Wake Lock API | ❌ 未対応 | Chrome/Edge のみ |
| **NoSleep.js** | ✅ 対応 | 非表示の動画再生でスリープ防止 |
| 動画ループ再生 | ✅ 対応 | NoSleep.js の内部実装と同等 |

**採用**: `NoSleep.js` ライブラリ（ユーザージェスチャー後に有効化）

### 3.2 周囲の明るさ推定

| 方法 | iOS対応 | 備考 |
|------|---------|------|
| Ambient Light Sensor API | ❌ 未対応 | |
| **カメラ映像解析** | ✅ 対応 | フロントカメラで輝度推定 |
| `devicelight` イベント | ❌ 廃止 | |
| 手動切り替え | ✅ 対応 | フォールバック |

**採用**: `getUserMedia` でフロントカメラ取得 → Canvas で輝度解析

### 3.3 メッセージ受信

#### 3.3.1 電力データ受信（remo-e SSE） — 合意済みインターフェース

PWA は同一LAN上の `remo-e-poc` が提供する **Server-Sent Events (SSE)** を直接購読して、瞬時電力（W）を受信する。

- Endpoint: `GET http://<mac-ip>:8787/events`
- Content-Type: `text/event-stream`
- Event name: `message`
- Payload: JSON（下記スキーマ）

```ts
// event.data を JSON.parse した結果
export interface PowerReadingEvent {
  type: 'power.reading';
  timestamp: string;  // ISO8601 (RFC3339)
  watts: number;      // 瞬時電力 (W)
  applianceId: string;
  nickname: string;
  sourceHost?: string;
}
```

動作要件:
- 接続直後に「最後の値（last event）」が即時に流れる（remo-e 側の replay）
- フォアグラウンド専用（iOS PWAはバックグラウンドで切断される想定）
- 再接続: `EventSource` の自動再接続に加え、`visibilitychange` で visible 時に再接続を試みる

---

| 方法 | iOS対応 | PWAバックグラウンド | 備考 |
|------|---------|---------------------|------|
| **WebSocket** | ✅ 対応 | ❌ 切断される | フォアグラウンド時は安定 |
| **SSE (Server-Sent Events)** | ✅ 対応 | ❌ 切断される | 単方向で十分なら軽量 |
| ポーリング | ✅ 対応 | ❌ 停止 | フォールバック |
| Push API + Service Worker | ⚠️ 限定的 | ✅ 対応 | iOS 16.4+ / 通知のみ |

**採用**: WebSocket（メイン） + 自動再接続 + 切断時ポーリングフォールバック

### 3.4 音声再生

| 方法 | iOS対応 | 備考 |
|------|---------|------|
| Web Audio API | ✅ 対応 | ユーザージェスチャー後に AudioContext 初期化必須 |
| `<audio>` 要素 | ✅ 対応 | 同上 |

**採用**: Web Audio API（事前にユーザータップで unlock）

---

## 4. アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│                    iOS PWA (Safari)                      │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │ NoSleep.js  │  │ Brightness  │  │ Message Client  │  │
│  │ (スリープ防止)│  │ Detector    │  │ (WebSocket/SSE) │  │
│  └─────────────┘  └──────┬──────┘  └────────┬────────┘  │
│                          │                   │           │
│                          ▼                   ▼           │
│                   ┌─────────────────────────────┐        │
│                   │      Display Controller     │        │
│                   │  - 表示内容管理              │        │
│                   │  - 明るさ/テーマ切替         │        │
│                   │  - サウンド再生              │        │
│                   └─────────────────────────────┘        │
│                                 │                        │
│                                 ▼                        │
│                   ┌─────────────────────────────┐        │
│                   │         UI Layer            │        │
│                   │  (React / Vanilla / Svelte) │        │
│                   └─────────────────────────────┘        │
└─────────────────────────────────────────────────────────┘
                              │
                              │ WebSocket / SSE
                              ▼
                    ┌───────────────────┐
                    │   Message Server   │
                    │  (バックエンド)     │
                    └───────────────────┘
```

---

## 5. コンポーネント詳細

### 5.1 NoSleep モジュール

```typescript
// nosleep-manager.ts
import NoSleep from 'nosleep.js';

class NoSleepManager {
  private noSleep = new NoSleep();
  private enabled = false;

  async enable(): Promise<void> {
    if (!this.enabled) {
      await this.noSleep.enable();
      this.enabled = true;
    }
  }

  disable(): void {
    this.noSleep.disable();
    this.enabled = false;
  }
}
```

**注意**: `enable()` はユーザージェスチャー（tap/click）のイベントハンドラ内で呼ぶ必要あり。

### 5.2 明るさ検出モジュール

```typescript
// brightness-detector.ts
interface BrightnessConfig {
  sampleIntervalMs: number;  // サンプリング間隔（例: 5000）
  sampleSize: number;        // 解析する画素数（例: 100）
}

class BrightnessDetector {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private stream: MediaStream | null = null;
  private intervalId: number | null = null;

  constructor(private config: BrightnessConfig) {
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', ''); // iOS必須
    this.video.setAttribute('autoplay', '');
    this.video.muted = true;
    
    this.canvas = document.createElement('canvas');
    this.canvas.width = 64;
    this.canvas.height = 64;
    this.ctx = this.canvas.getContext('2d')!;
  }

  async start(onBrightness: (level: number) => void): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 64, height: 64 }
      });
      this.video.srcObject = this.stream;
      await this.video.play();

      this.intervalId = window.setInterval(() => {
        const brightness = this.measureBrightness();
        onBrightness(brightness);
      }, this.config.sampleIntervalMs);
    } catch (e) {
      console.warn('Camera not available, using fallback');
      // 手動モードにフォールバック
    }
  }

  private measureBrightness(): number {
    this.ctx.drawImage(this.video, 0, 0, 64, 64);
    const imageData = this.ctx.getImageData(0, 0, 64, 64);
    const data = imageData.data;
    
    let totalLuminance = 0;
    const step = Math.floor(data.length / 4 / this.config.sampleSize);
    let samples = 0;
    
    for (let i = 0; i < data.length; i += step * 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // 相対輝度 (ITU-R BT.709)
      totalLuminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      samples++;
    }
    
    return totalLuminance / samples / 255; // 0.0 - 1.0
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
    }
  }
}
```

### 5.3 メッセージクライアント

```typescript
// message-client.ts
type MessageHandler = (message: DisplayMessage) => void;

interface DisplayMessage {
  type: 'text' | 'image' | 'alert' | 'clear';
  content?: string;
  style?: {
    backgroundColor?: string;
    textColor?: string;
    fontSize?: string;
  };
  sound?: 'default' | 'alert' | 'chime' | string;
  duration?: number; // ms, 0 = permanent
}

class MessageClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private handlers: Set<MessageHandler> = new Set();

  constructor(private wsUrl: string) {}

  connect(): void {
    this.ws = new WebSocket(this.wsUrl);
    
    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const message: DisplayMessage = JSON.parse(event.data);
        this.handlers.forEach(h => h(message));
      } catch (e) {
        console.error('Invalid message', e);
      }
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };

    this.ws.onerror = (e) => {
      console.error('WebSocket error', e);
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      setTimeout(() => {
        this.reconnectAttempts++;
        this.connect();
      }, delay);
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  disconnect(): void {
    this.ws?.close();
  }
}
```

### 5.4 サウンドマネージャー

```typescript
// sound-manager.ts
class SoundManager {
  private audioContext: AudioContext | null = null;
  private sounds: Map<string, AudioBuffer> = new Map();
  private unlocked = false;

  // ユーザージェスチャー内で呼ぶ
  async unlock(): Promise<void> {
    if (this.unlocked) return;
    
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    // iOS Safari: 無音を再生してunlock
    const buffer = this.audioContext.createBuffer(1, 1, 22050);
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    source.start(0);
    
    this.unlocked = true;
  }

  async loadSound(name: string, url: string): Promise<void> {
    if (!this.audioContext) return;
    
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    this.sounds.set(name, audioBuffer);
  }

  play(name: string): void {
    if (!this.audioContext || !this.unlocked) return;
    
    const buffer = this.sounds.get(name);
    if (!buffer) return;
    
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    source.start(0);
  }
}
```

### 5.5 ディスプレイコントローラー

```typescript
// display-controller.ts
interface DisplayState {
  brightness: 'auto' | 'light' | 'dark';
  ambientLevel: number;
  currentMessage: DisplayMessage | null;
}

class DisplayController {
  private state: DisplayState = {
    brightness: 'auto',
    ambientLevel: 0.5,
    currentMessage: null
  };

  private noSleep: NoSleepManager;
  private brightnessDetector: BrightnessDetector;
  private messageClient: MessageClient;
  private soundManager: SoundManager;
  private renderCallback: (state: DisplayState) => void;

  constructor(config: {
    wsUrl: string;
    onRender: (state: DisplayState) => void;
  }) {
    this.noSleep = new NoSleepManager();
    this.brightnessDetector = new BrightnessDetector({
      sampleIntervalMs: 5000,
      sampleSize: 100
    });
    this.messageClient = new MessageClient(config.wsUrl);
    this.soundManager = new SoundManager();
    this.renderCallback = config.onRender;
  }

  // ユーザージェスチャー内で呼ぶ（初回タップ時）
  async initialize(): Promise<void> {
    // 1. スリープ防止
    await this.noSleep.enable();
    
    // 2. サウンドunlock
    await this.soundManager.unlock();
    await this.soundManager.loadSound('default', '/sounds/notification.mp3');
    await this.soundManager.loadSound('alert', '/sounds/alert.mp3');
    
    // 3. 明るさ検出開始
    await this.brightnessDetector.start((level) => {
      this.state.ambientLevel = level;
      this.applyBrightness();
      this.render();
    });
    
    // 4. メッセージ受信開始
    this.messageClient.onMessage((msg) => this.handleMessage(msg));
    this.messageClient.connect();
  }

  private handleMessage(message: DisplayMessage): void {
    this.state.currentMessage = message;
    
    // サウンド再生
    if (message.sound) {
      this.soundManager.play(message.sound);
    }
    
    // 一定時間後にクリア
    if (message.duration && message.duration > 0) {
      setTimeout(() => {
        if (this.state.currentMessage === message) {
          this.state.currentMessage = null;
          this.render();
        }
      }, message.duration);
    }
    
    this.render();
  }

  private applyBrightness(): void {
    const level = this.state.ambientLevel;
    // 0.0-0.3: dark, 0.3-0.7: auto, 0.7-1.0: light
    // CSS変数で制御
    document.documentElement.style.setProperty(
      '--ambient-brightness',
      level.toString()
    );
  }

  private render(): void {
    this.renderCallback(this.state);
  }
}
```

---

## 6. UIコンポーネント

### 6.1 初期化画面（タップ待ち）

```html
<div id="init-screen" class="fullscreen center">
  <p>タップして開始</p>
</div>
```

ユーザーがタップするまで表示。タップで `DisplayController.initialize()` を呼ぶ。

### 6.2 メイン表示画面

```html
<div id="display" class="fullscreen">
  <div id="message-area">
    <!-- 動的にメッセージ表示 -->
  </div>
  <div id="status-bar">
    <span id="connection-status">●</span>
    <span id="brightness-indicator">☀</span>
  </div>
</div>
```

### 6.3 CSSテーマ（明るさ連動）

```css
:root {
  --ambient-brightness: 0.5;
  
  /* 明るさに応じた色 */
  --bg-color: color-mix(
    in srgb,
    #ffffff calc(var(--ambient-brightness) * 100%),
    #1a1a1a
  );
  --text-color: color-mix(
    in srgb,
    #000000 calc(var(--ambient-brightness) * 100%),
    #ffffff
  );
}

body {
  background-color: var(--bg-color);
  color: var(--text-color);
  transition: background-color 0.5s, color 0.5s;
}

.fullscreen {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
```

---

## 7. PWA マニフェスト

```json
{
  "name": "Display App",
  "short_name": "Display",
  "start_url": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

---

## 8. メッセージプロトコル

### 8.1 サーバー → クライアント

```typescript
interface DisplayMessage {
  type: 'text' | 'image' | 'alert' | 'clear' | 'config';
  
  // type: 'text'
  content?: string;
  
  // type: 'image'
  imageUrl?: string;
  
  // type: 'alert'
  title?: string;
  body?: string;
  
  // 共通オプション
  style?: {
    backgroundColor?: string;
    textColor?: string;
    fontSize?: 'small' | 'medium' | 'large' | 'xlarge';
    animation?: 'none' | 'fade' | 'slide' | 'pulse';
  };
  
  sound?: 'none' | 'default' | 'alert' | 'chime';
  duration?: number; // ms, 0 = 永続
  priority?: 'low' | 'normal' | 'high';
}
```

### 8.2 クライアント → サーバー（ステータス通知）

```typescript
interface ClientStatus {
  type: 'status';
  connected: boolean;
  ambientBrightness: number;
  timestamp: number;
}
```

---

## 9. サーバー側（参考）

最小構成例（Node.js + ws）:

```typescript
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

// メッセージ送信API
function broadcast(message: DisplayMessage) {
  const data = JSON.stringify(message);
  clients.forEach(ws => ws.send(data));
}
```

---

## 10. ディレクトリ構成案

```
ios-pwa-display/
├── public/
│   ├── index.html
│   ├── manifest.json
│   ├── sw.js
│   ├── sounds/
│   │   ├── notification.mp3
│   │   └── alert.mp3
│   └── icons/
├── src/
│   ├── main.ts
│   ├── controllers/
│   │   └── display-controller.ts
│   ├── services/
│   │   ├── nosleep-manager.ts
│   │   ├── brightness-detector.ts
│   │   ├── message-client.ts
│   │   └── sound-manager.ts
│   ├── components/
│   │   ├── InitScreen.tsx
│   │   └── DisplayScreen.tsx
│   └── styles/
│       └── main.css
├── server/
│   └── index.ts
├── package.json
└── DESIGN.md
```

---

## 11. 制約・注意事項

| 項目 | 制約 | 対策 |
|------|------|------|
| スリープ防止 | ユーザージェスチャー必須 | 初回タップ画面を設ける |
| カメラアクセス | HTTPS必須 / ユーザー許可必要 | 許可拒否時は手動モードにフォールバック |
| 音声再生 | ユーザージェスチャー後のみ | 初回タップで AudioContext unlock |
| WebSocket | バックグラウンドで切断 | 自動再接続 + visibilitychange で再接続 |
| PWAインストール | iOS Safari から「ホーム画面に追加」 | インストール誘導UIを表示 |

---

## 12. remo-e 連携: SSE インターフェース仕様

### 12.1 概要

remo-e (Nature Remo E 電力モニター) から電力データを SSE で受信し、リアルタイム表示する。

### 12.2 SSE Endpoint (remo-e 側)

| 項目 | 値 |
|------|-----|
| URL | `GET http://<mac-ip>:8787/events` |
| Content-Type | `text/event-stream` |
| Event name | `message` |
| CORS | `Access-Control-Allow-Origin: *` |

### 12.3 Event Schema

```typescript
interface PowerReadingEvent {
  type: 'power.reading';
  timestamp: string;    // ISO8601 (RFC3339) e.g. "2026-02-04T23:51:18+09:00"
  watts: number;        // 瞬時電力 (W), 正=買電, 負=売電
  applianceId: string;  // Nature API の appliance ID
  nickname: string;     // e.g. "Remo E"
  sourceHost?: string;  // e.g. "ai-mac"
}
```

### 12.4 接続仕様

- 接続時に **最後の値が即座に送信される** (remo-e の last event replay)
- 25秒間隔で keep-alive コメント (`: keepalive`)
- 自動再接続は `EventSource` がネイティブ対応
- PWA 側で `visibilitychange` 時に再接続チェック

### 12.5 PWA側の実装

```typescript
const es = new EventSource('http://192.168.1.x:8787/events');

es.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'power.reading') {
    // watts を表示に反映
    displayWatts(data.watts);
  }
};
```

### 12.6 閾値アラート

PWA 側で閾値 (デフォルト 2000W) を超えた場合:
- 表示を赤くハイライト
- アラート音を再生（閾値を超えた瞬間のみ）

---

## 13. 今後の拡張案

- **Push通知**: iOS 16.4+ の Web Push 対応（バックグラウンド通知）
- **複数デバイス同期**: 同一アカウントの複数端末で同時表示
- **テンプレート**: 時計、天気、カレンダーなどの定型表示
- **ジェスチャー操作**: スワイプでメッセージ消去、長押しで設定
