/**
 * SSE Client - Server-Sent Events で電力データを受信する
 * 
 * remo-e からの power.reading イベントを購読する。
 * EventSource はネイティブで自動再接続をサポート。
 */

export interface PowerReadingEvent {
  type: 'power.reading';
  timestamp: string;  // ISO8601 (RFC3339)
  watts: number;      // 瞬時電力 (W)
  applianceId: string;
  nickname: string;
  sourceHost?: string;
}

export type PowerReadingHandler = (event: PowerReadingEvent) => void;
export type SSEConnectionState = 'connected' | 'connecting' | 'disconnected';
export type SSEConnectionHandler = (state: SSEConnectionState) => void;

export class SSEClient {
  private eventSource: EventSource | null = null;
  private _sseUrl: string;
  private _state: SSEConnectionState = 'disconnected';
  private readingHandlers = new Set<PowerReadingHandler>();
  private connectionHandlers = new Set<SSEConnectionHandler>();
  private shouldConnect = false;
  private reconnectTimeoutId: number | null = null;

  constructor(sseUrl: string) {
    this._sseUrl = sseUrl;

    // ページが表示されたら再接続を試みる
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.shouldConnect) {
        if (this._state === 'disconnected') {
          console.log('[SSEClient] Page visible, reconnecting...');
          this.connect();
        }
      }
    });
  }

  get state(): SSEConnectionState {
    return this._state;
  }

  get sseUrl(): string {
    return this._sseUrl;
  }

  set sseUrl(url: string) {
    const wasConnected = this.shouldConnect;
    this.disconnect();
    this._sseUrl = url;
    if (wasConnected) {
      this.connect();
    }
  }

  private setState(state: SSEConnectionState): void {
    if (this._state !== state) {
      this._state = state;
      this.connectionHandlers.forEach(h => h(state));
    }
  }

  /**
   * SSE 接続を開始
   */
  connect(): void {
    if (!this._sseUrl) {
      console.warn('[SSEClient] No SSE URL configured');
      return;
    }

    this.shouldConnect = true;

    if (this.eventSource?.readyState === EventSource.OPEN) {
      return;
    }

    // 前の接続をクリーンアップ
    if (this.eventSource) {
      this.eventSource.close();
    }

    this.setState('connecting');
    console.log('[SSEClient] Connecting to', this._sseUrl);

    try {
      this.eventSource = new EventSource(this._sseUrl);

      this.eventSource.onopen = () => {
        console.log('[SSEClient] Connected');
        this.setState('connected');
      };

      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'power.reading') {
            console.log('[SSEClient] Received power reading:', data.watts, 'W');
            this.readingHandlers.forEach(h => h(data as PowerReadingEvent));
          }
        } catch (err) {
          console.error('[SSEClient] Invalid message:', err);
        }
      };

      this.eventSource.onerror = (err) => {
        console.error('[SSEClient] Error:', err);
        this.setState('disconnected');
        
        // EventSource は自動再接続するが、追加のハンドリング
        if (this.eventSource?.readyState === EventSource.CLOSED) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      console.error('[SSEClient] Failed to create EventSource:', err);
      this.setState('disconnected');
      this.scheduleReconnect();
    }
  }

  /**
   * 再接続をスケジュール
   */
  private scheduleReconnect(): void {
    if (!this.shouldConnect) return;
    if (this.reconnectTimeoutId) return;

    console.log('[SSEClient] Scheduling reconnect in 5s');
    this.reconnectTimeoutId = window.setTimeout(() => {
      this.reconnectTimeoutId = null;
      if (this.shouldConnect && this._state === 'disconnected') {
        this.connect();
      }
    }, 5000);
  }

  /**
   * 電力データ受信ハンドラを登録
   */
  onPowerReading(handler: PowerReadingHandler): () => void {
    this.readingHandlers.add(handler);
    return () => this.readingHandlers.delete(handler);
  }

  /**
   * 接続状態変更ハンドラを登録
   */
  onConnectionChange(handler: SSEConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    handler(this._state);
    return () => this.connectionHandlers.delete(handler);
  }

  /**
   * 接続を切断
   */
  disconnect(): void {
    this.shouldConnect = false;

    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this.setState('disconnected');
  }
}
