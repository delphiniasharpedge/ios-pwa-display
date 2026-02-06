/**
 * Display Controller - 全体を統括するコントローラー
 */

import { NoSleepManager } from '../services/nosleep-manager';
import { BrightnessDetector } from '../services/brightness-detector';
import { MessageClient, type DisplayMessage, type ConnectionState } from '../services/message-client';
import { SSEClient, type PowerReadingEvent, type SSEConnectionState } from '../services/sse-client';
import { SoundManager } from '../services/sound-manager';
import { clamp01, lerpColor, normalizeBrightness } from '../utils/brightness';

export interface DisplayConfig {
  wsUrl: string;
  sseUrl: string;
  brightnessMode: 'auto' | 'light' | 'dark';

  // High wattage alert
  alertThresholdWatts: number; // watts >= threshold => HIGH
  alertRepeatIntervalSec: number; // while HIGH, repeat at this interval
  alertStaleStopSec: number; // stop repeating if no readings for this long
  alertRecoveryMarginWatts: number; // recovery when watts < threshold - margin

  // Voice announcement (optional)
  alertAnnounceEnabled: boolean;
  alertAnnounceMode: 'speech' | 'audio';
  alertAnnounceSoundName: string;
  alertAnnounceMessage: string;

  // Brightness calibration (raw 0..1 -> normalized 0..1)
  brightnessMinThreshold: number; // raw <= this => 0%
  brightnessMaxThreshold: number; // raw >= this => 100%

  // Text color range (normalized brightness 0..1)
  textColorMin: string; // dark
  textColorMax: string; // bright

  // LocalStorage migration/versioning
  configVersion?: number;
}

export interface DisplayState {
  initialized: boolean;
  wsConnected: ConnectionState;
  sseConnected: SSEConnectionState;
  brightnessMode: 'auto' | 'light' | 'dark';
  ambientLevel: number;
  cameraAvailable: boolean;
  currentMessage: DisplayMessage | null;
  currentPower: PowerReadingEvent | null;
}

export type StateChangeHandler = (state: DisplayState) => void;

const STORAGE_KEY = 'ios-pwa-display-config';
// High wattage alert defaults
const DEFAULT_ALERT_THRESHOLD_WATTS = 1000;
const DEFAULT_ALERT_REPEAT_INTERVAL_SEC = 20;
const DEFAULT_ALERT_STALE_STOP_SEC = 60;
const DEFAULT_ALERT_RECOVERY_MARGIN_WATTS = 0;
const DEFAULT_ALERT_ANNOUNCE_ENABLED = true;
const DEFAULT_ALERT_ANNOUNCE_MODE: 'speech' | 'audio' = 'audio';
const DEFAULT_ALERT_ANNOUNCE_SOUND_NAME = 'voice_high_wattage_ja';
const DEFAULT_ALERT_ANNOUNCE_MESSAGE = '消費電力が高くなっています。不要な家電の運転を停止してください。';

const DEFAULT_BRIGHTNESS_MIN_THRESHOLD = 0.2;
const DEFAULT_BRIGHTNESS_MAX_THRESHOLD = 0.8;
const DEFAULT_TEXT_COLOR_MIN = '#4b5563';
const DEFAULT_TEXT_COLOR_MAX = '#ffffff';

export class DisplayController {
  private noSleep: NoSleepManager;
  private brightnessDetector: BrightnessDetector;
  private messageClient: MessageClient;
  private sseClient: SSEClient;
  private soundManager: SoundManager;

  // Configurable alert settings
  private alertThresholdWatts: number;
  private alertRepeatIntervalSec: number;
  private alertStaleStopSec: number;
  private alertRecoveryMarginWatts: number;
  private alertAnnounceEnabled: boolean;
  private alertAnnounceMode: 'speech' | 'audio';
  private alertAnnounceSoundName: string;
  private alertAnnounceMessage: string;

  // Configurable brightness/text settings
  private brightnessMinThreshold: number;
  private brightnessMaxThreshold: number;
  private textColorMin: string;
  private textColorMax: string;

  private stateHandlers = new Set<StateChangeHandler>();
  private messageTimeoutId: number | null = null;

  // High wattage alert runtime
  private alertState: 'normal' | 'high' = 'normal';
  private alertTimerId: number | null = null;
  private lastReadingAtMs: number = 0;
  private lastAnnounceAtMs: number = 0;

  private _state: DisplayState = {
    initialized: false,
    wsConnected: 'disconnected',
    sseConnected: 'disconnected',
    brightnessMode: 'auto',
    ambientLevel: 0.5,
    cameraAvailable: false,
    currentMessage: null,
    currentPower: null,
  };

  constructor(baseConfig?: Partial<DisplayConfig>) {
    // 設定を復元（baseConfig -> localStorage）
    const savedConfig = this.loadConfig(baseConfig);

    this.noSleep = new NoSleepManager();
    this.brightnessDetector = new BrightnessDetector({
      sampleIntervalMs: 3000,
      resolution: 32,
      smoothingWindow: 5,
    });
    this.messageClient = new MessageClient(savedConfig.wsUrl);
    this.sseClient = new SSEClient(savedConfig.sseUrl);
    this.soundManager = new SoundManager();

    this._state.brightnessMode = savedConfig.brightnessMode;

    this.alertThresholdWatts = savedConfig.alertThresholdWatts;
    this.alertRepeatIntervalSec = savedConfig.alertRepeatIntervalSec;
    this.alertStaleStopSec = savedConfig.alertStaleStopSec;
    this.alertRecoveryMarginWatts = savedConfig.alertRecoveryMarginWatts;
    this.alertAnnounceEnabled = savedConfig.alertAnnounceEnabled;
    this.alertAnnounceMode = savedConfig.alertAnnounceMode;
    this.alertAnnounceSoundName = savedConfig.alertAnnounceSoundName;
    this.alertAnnounceMessage = savedConfig.alertAnnounceMessage;

    this.brightnessMinThreshold = savedConfig.brightnessMinThreshold;
    this.brightnessMaxThreshold = savedConfig.brightnessMaxThreshold;
    this.textColorMin = savedConfig.textColorMin;
    this.textColorMax = savedConfig.textColorMax;

    // WebSocket 接続状態の変更を監視
    this.messageClient.onConnectionChange((state) => {
      this._state.wsConnected = state;
      this.notifyStateChange();
    });

    // WebSocket メッセージの受信を監視
    this.messageClient.onMessage((msg) => this.handleMessage(msg));

    // SSE 接続状態の変更を監視
    this.sseClient.onConnectionChange((state) => {
      this._state.sseConnected = state;

      // If SSE disconnects, stop repeating alert to avoid endless noise.
      if (state === 'disconnected') {
        this.stopHighAlert('sse-disconnected');
      }

      this.notifyStateChange();
    });

    // SSE 電力データの受信を監視
    this.sseClient.onPowerReading((event) => this.handlePowerReading(event));
  }

  get state(): DisplayState {
    return { ...this._state };
  }

  get wsUrl(): string {
    return this.messageClient.wsUrl;
  }

  get sseUrl(): string {
    return this.sseClient.sseUrl;
  }

  getAlertThresholdWatts(): number {
    return this.alertThresholdWatts;
  }

  getAlertRepeatIntervalSec(): number {
    return this.alertRepeatIntervalSec;
  }

  /**
   * 設定を保存
   */
  private saveConfig(): void {
    const config: DisplayConfig = {
      wsUrl: this.messageClient.wsUrl,
      sseUrl: this.sseClient.sseUrl,
      brightnessMode: this._state.brightnessMode,

      alertThresholdWatts: this.alertThresholdWatts,
      alertRepeatIntervalSec: this.alertRepeatIntervalSec,
      alertStaleStopSec: this.alertStaleStopSec,
      alertRecoveryMarginWatts: this.alertRecoveryMarginWatts,
      alertAnnounceEnabled: this.alertAnnounceEnabled,
      alertAnnounceMode: this.alertAnnounceMode,
      alertAnnounceSoundName: this.alertAnnounceSoundName,
      alertAnnounceMessage: this.alertAnnounceMessage,

      brightnessMinThreshold: this.brightnessMinThreshold,
      brightnessMaxThreshold: this.brightnessMaxThreshold,
      textColorMin: this.textColorMin,
      textColorMax: this.textColorMax,

      configVersion: 3,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  /**
   * 設定を読み込み
   */
  private loadConfig(baseConfig?: Partial<DisplayConfig>): DisplayConfig {
    const base: DisplayConfig = {
      wsUrl: baseConfig?.wsUrl?.trim?.() || '',
      sseUrl: (baseConfig?.sseUrl || '/events').trim(),
      brightnessMode: baseConfig?.brightnessMode || 'auto',

      alertThresholdWatts: baseConfig?.alertThresholdWatts ?? DEFAULT_ALERT_THRESHOLD_WATTS,
      alertRepeatIntervalSec: baseConfig?.alertRepeatIntervalSec ?? DEFAULT_ALERT_REPEAT_INTERVAL_SEC,
      alertStaleStopSec: baseConfig?.alertStaleStopSec ?? DEFAULT_ALERT_STALE_STOP_SEC,
      alertRecoveryMarginWatts: baseConfig?.alertRecoveryMarginWatts ?? DEFAULT_ALERT_RECOVERY_MARGIN_WATTS,
      alertAnnounceEnabled: baseConfig?.alertAnnounceEnabled ?? DEFAULT_ALERT_ANNOUNCE_ENABLED,
      alertAnnounceMode: baseConfig?.alertAnnounceMode ?? DEFAULT_ALERT_ANNOUNCE_MODE,
      alertAnnounceSoundName: baseConfig?.alertAnnounceSoundName ?? DEFAULT_ALERT_ANNOUNCE_SOUND_NAME,
      alertAnnounceMessage: baseConfig?.alertAnnounceMessage ?? DEFAULT_ALERT_ANNOUNCE_MESSAGE,

      brightnessMinThreshold: baseConfig?.brightnessMinThreshold ?? DEFAULT_BRIGHTNESS_MIN_THRESHOLD,
      brightnessMaxThreshold: baseConfig?.brightnessMaxThreshold ?? DEFAULT_BRIGHTNESS_MAX_THRESHOLD,
      textColorMin: baseConfig?.textColorMin ?? DEFAULT_TEXT_COLOR_MIN,
      textColorMax: baseConfig?.textColorMax ?? DEFAULT_TEXT_COLOR_MAX,

      configVersion: 3,
    };

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const config = JSON.parse(saved);
        const version = Number(config.configVersion || 1);

        // Default to same-origin SSE so it works with HTTPS hosting (e.g. Tailscale Serve).
        // Migration: if an old config points directly to http://<host>:8787/events and we're
        // currently on HTTPS, switch to same-origin /events to avoid mixed content.
        let sseUrl = (config.sseUrl || '').trim();
        if (!sseUrl) {
          sseUrl = '/events';
        } else if (
          version < 2 &&
          typeof window !== 'undefined' &&
          window.location?.protocol === 'https:' &&
          /^http:\/\//.test(sseUrl)
        ) {
          // v1 -> v2 migration: avoid mixed content when the app itself is served over HTTPS.
          sseUrl = '/events';
        }

        return {
          ...base,
          wsUrl: (config.wsUrl || base.wsUrl).trim(),
          sseUrl,
          brightnessMode: config.brightnessMode || base.brightnessMode,

          alertThresholdWatts: config.alertThresholdWatts ?? base.alertThresholdWatts,
          alertRepeatIntervalSec: config.alertRepeatIntervalSec ?? base.alertRepeatIntervalSec,
          alertStaleStopSec: config.alertStaleStopSec ?? base.alertStaleStopSec,
          alertRecoveryMarginWatts: config.alertRecoveryMarginWatts ?? base.alertRecoveryMarginWatts,
          alertAnnounceEnabled: config.alertAnnounceEnabled ?? base.alertAnnounceEnabled,
          alertAnnounceMode: config.alertAnnounceMode ?? base.alertAnnounceMode,
          alertAnnounceSoundName: config.alertAnnounceSoundName ?? base.alertAnnounceSoundName,
          alertAnnounceMessage: config.alertAnnounceMessage ?? base.alertAnnounceMessage,

          brightnessMinThreshold: config.brightnessMinThreshold ?? base.brightnessMinThreshold,
          brightnessMaxThreshold: config.brightnessMaxThreshold ?? base.brightnessMaxThreshold,
          textColorMin: config.textColorMin ?? base.textColorMin,
          textColorMax: config.textColorMax ?? base.textColorMax,

          configVersion: 3,
        };
      }
    } catch (err) {
      console.warn('[DisplayController] Failed to load config:', err);
    }
    // デフォルト設定
    return base;
  }

  /**
   * 設定を更新
   */
  updateConfig(config: Partial<DisplayConfig>): void {
    if (config.wsUrl !== undefined) {
      this.messageClient.wsUrl = config.wsUrl;
    }
    if (config.sseUrl !== undefined) {
      this.sseClient.sseUrl = config.sseUrl;
      // SSE URL が設定されたら接続開始
      if (config.sseUrl && this._state.initialized) {
        this.sseClient.connect();
      }
    }
    if (config.brightnessMode !== undefined) {
      this._state.brightnessMode = config.brightnessMode;
      this.applyBrightness(this._state.ambientLevel);
    }
    let alertConfigChanged = false;
    if (config.alertThresholdWatts !== undefined) {
      this.alertThresholdWatts = config.alertThresholdWatts;
      alertConfigChanged = true;
    }
    if (config.alertRepeatIntervalSec !== undefined) {
      this.alertRepeatIntervalSec = config.alertRepeatIntervalSec;
      alertConfigChanged = true;
    }
    if (config.alertStaleStopSec !== undefined) {
      this.alertStaleStopSec = config.alertStaleStopSec;
      alertConfigChanged = true;
    }
    if (config.alertRecoveryMarginWatts !== undefined) {
      this.alertRecoveryMarginWatts = config.alertRecoveryMarginWatts;
      alertConfigChanged = true;
    }
    if (config.alertAnnounceEnabled !== undefined) {
      this.alertAnnounceEnabled = config.alertAnnounceEnabled;
      alertConfigChanged = true;
    }
    if (config.alertAnnounceMode !== undefined) {
      this.alertAnnounceMode = config.alertAnnounceMode;
      alertConfigChanged = true;
    }
    if (config.alertAnnounceSoundName !== undefined) {
      this.alertAnnounceSoundName = config.alertAnnounceSoundName;
      alertConfigChanged = true;
    }
    if (config.alertAnnounceMessage !== undefined) {
      this.alertAnnounceMessage = config.alertAnnounceMessage;
      alertConfigChanged = true;
    }

    if (config.brightnessMinThreshold !== undefined) {
      this.brightnessMinThreshold = config.brightnessMinThreshold;
    }
    if (config.brightnessMaxThreshold !== undefined) {
      this.brightnessMaxThreshold = config.brightnessMaxThreshold;
    }
    if (config.textColorMin !== undefined) {
      this.textColorMin = config.textColorMin;
    }
    if (config.textColorMax !== undefined) {
      this.textColorMax = config.textColorMax;
    }

    // Re-apply current brightness after config changes.
    this.applyBrightness(this._state.ambientLevel);

    // Restart repeating alert timer if needed.
    if (alertConfigChanged) {
      this.refreshHighAlertTimer();
    }

    this.saveConfig();
    this.notifyStateChange();
  }

  /**
   * 初期化（ユーザージェスチャー内で呼ぶ）
   */
  async initialize(): Promise<void> {
    if (this._state.initialized) return;

    console.log('[DisplayController] Initializing...');

    // 1. スリープ防止を有効化
    await this.noSleep.enable();

    // 2. サウンドをアンロック
    await this.soundManager.unlock();

    // 3. 明るさ検出を開始（カメラ許可を求める）
    if (this._state.brightnessMode === 'auto') {
      const available = await this.brightnessDetector.start((rawLevel) => {
        const level = normalizeBrightness(rawLevel, this.brightnessMinThreshold, this.brightnessMaxThreshold);
        this._state.ambientLevel = level;
        this.applyBrightness(level);
        this.notifyStateChange();
      });
      this._state.cameraAvailable = available;

      if (!available) {
        console.log('[DisplayController] Camera not available, using manual mode');
        this.applyTimeBasedBrightness();
      }
    } else {
      this.applyBrightness(this._state.brightnessMode === 'light' ? 1 : 0);
    }

    // 4. WebSocket 接続を開始（設定されていれば）
    if (this.messageClient.wsUrl) {
      this.messageClient.connect();
    }

    // 5. SSE 接続を開始（設定されていれば）
    if (this.sseClient.sseUrl) {
      this.sseClient.connect();
    }

    this._state.initialized = true;
    this.notifyStateChange();

    console.log('[DisplayController] Initialized');
  }

  // Brightness helpers are implemented in src/utils/brightness.ts

  /**
   * 明るさを適用
   */
  private applyBrightness(level: number): void {
    let effectiveLevel: number;

    switch (this._state.brightnessMode) {
      case 'light':
        effectiveLevel = 1;
        break;
      case 'dark':
        effectiveLevel = 0;
        break;
      case 'auto':
      default:
        effectiveLevel = clamp01(level);
    }

    document.documentElement.style.setProperty(
      '--ambient-brightness',
      effectiveLevel.toFixed(2)
    );

    // Spec: background stays black; only text color changes.
    // Color is interpolated between min..max by brightness.
    const textColor = lerpColor(this.textColorMin, this.textColorMax, effectiveLevel);
    document.documentElement.style.setProperty('--ambient-text-color', textColor);
  }

  /**
   * 時間帯に基づく明るさ（カメラ不可時のフォールバック）
   */
  private applyTimeBasedBrightness(): void {
    const hour = new Date().getHours();
    const level = (hour >= 6 && hour < 18) ? 0.7 : 0.2;
    this._state.ambientLevel = level;
    this.applyBrightness(level);
    this.notifyStateChange();

    setInterval(() => {
      if (this._state.brightnessMode === 'auto' && !this._state.cameraAvailable) {
        this.applyTimeBasedBrightness();
      }
    }, 3600000);
  }

  private isHighWatts(watts: number): boolean {
    return watts >= this.alertThresholdWatts;
  }

  private isRecoveredWatts(watts: number): boolean {
    return watts < (this.alertThresholdWatts - this.alertRecoveryMarginWatts);
  }

  private announceHighAlert(): void {
    const msg = (this.alertAnnounceMessage || '').trim();

    // Always play a chime as an attention grabber.
    this.soundManager.play('chime');

    if (!this.alertAnnounceEnabled) return;

    if (this.alertAnnounceMode === 'audio') {
      this.soundManager.play(this.alertAnnounceSoundName || 'voice_high_wattage_ja');
      this.lastAnnounceAtMs = Date.now();
      return;
    }

    // speech
    if (!msg) return;
    this.soundManager.announce(msg);
    this.lastAnnounceAtMs = Date.now();
  }

  private startHighAlert(): void {
    this.alertState = 'high';

    // Immediate alert when entering HIGH.
    this.announceHighAlert();

    this.refreshHighAlertTimer();
  }

  private stopHighAlert(reason: string): void {
    if (this.alertState !== 'high' && !this.alertTimerId) return;

    this.alertState = 'normal';

    if (this.alertTimerId) {
      clearInterval(this.alertTimerId);
      this.alertTimerId = null;
    }

    // Optional debug
    // console.log('[DisplayController] stopHighAlert:', reason);
  }

  private refreshHighAlertTimer(): void {
    // Only run timer while HIGH.
    if (this.alertState !== 'high') {
      if (this.alertTimerId) {
        clearInterval(this.alertTimerId);
        this.alertTimerId = null;
      }
      return;
    }

    // Restart timer with current interval.
    if (this.alertTimerId) {
      clearInterval(this.alertTimerId);
      this.alertTimerId = null;
    }

    const intervalMs = Math.max(1, Math.floor(this.alertRepeatIntervalSec)) * 1000;

    this.alertTimerId = window.setInterval(() => {
      // Stop if stale (no readings for too long) to avoid endless noise.
      const now = Date.now();
      const staleMs = Math.max(1, Math.floor(this.alertStaleStopSec)) * 1000;
      if (this.lastReadingAtMs > 0 && now - this.lastReadingAtMs >= staleMs) {
        this.stopHighAlert('stale-readings');
        return;
      }

      if (this.alertState === 'high') {
        // Repeat while HIGH.
        this.announceHighAlert();
      }
    }, intervalMs);
  }

  /**
   * 電力データを処理
   */
  private handlePowerReading(event: PowerReadingEvent): void {
    console.log('[DisplayController] Power reading:', event.watts, 'W');

    this.lastReadingAtMs = Date.now();
    this._state.currentPower = event;

    if (this.alertState !== 'high') {
      if (this.isHighWatts(event.watts)) {
        this.startHighAlert();
      }
    } else {
      if (this.isRecoveredWatts(event.watts)) {
        this.stopHighAlert('recovered');
      }
    }

    this.notifyStateChange();
  }

  /**
   * WebSocket メッセージを処理
   */
  private handleMessage(message: DisplayMessage): void {
    console.log('[DisplayController] Handling message:', message);

    if (this.messageTimeoutId) {
      clearTimeout(this.messageTimeoutId);
      this.messageTimeoutId = null;
    }

    if (message.type === 'clear') {
      this._state.currentMessage = null;
      this.notifyStateChange();
      return;
    }

    if (message.type === 'config') {
      return;
    }

    this._state.currentMessage = message;

    if (message.sound && message.sound !== 'none') {
      this.soundManager.play(message.sound);
    }

    if (message.duration && message.duration > 0) {
      this.messageTimeoutId = window.setTimeout(() => {
        if (this._state.currentMessage === message) {
          this._state.currentMessage = null;
          this.notifyStateChange();
        }
      }, message.duration);
    }

    this.notifyStateChange();
  }

  /**
   * 状態変更ハンドラを登録
   */
  onStateChange(handler: StateChangeHandler): () => void {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => this.stateHandlers.delete(handler);
  }

  /**
   * 状態変更を通知
   */
  private notifyStateChange(): void {
    const state = this.state;
    this.stateHandlers.forEach(h => h(state));
  }

  /**
   * 破棄
   */
  destroy(): void {
    this.noSleep.disable();
    this.brightnessDetector.stop();
    this.messageClient.disconnect();
    this.sseClient.disconnect();
    if (this.messageTimeoutId) {
      clearTimeout(this.messageTimeoutId);
    }
  }
}
