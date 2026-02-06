/**
 * iOS PWA Display - メインエントリーポイント
 */

import { DisplayController, type DisplayState, type DisplayConfig } from './controllers/display-controller';
import type { DisplayMessage } from './services/message-client';
import type { PowerReadingEvent } from './services/sse-client';

// DOM要素
const initScreen = document.getElementById('init-screen')!;
const displayScreen = document.getElementById('display-screen')!;
const messageContent = document.getElementById('message-content')!;
const connectionStatus = document.getElementById('connection-status')!;
const brightnessValue = document.getElementById('brightness-value')!;
const settingsPanel = document.getElementById('settings-panel')!;
const wsUrlInput = document.getElementById('ws-url') as HTMLInputElement;
const sseUrlInput = document.getElementById('sse-url') as HTMLInputElement;
const brightnessModeSelect = document.getElementById('brightness-mode') as HTMLSelectElement;
const settingsSaveBtn = document.getElementById('settings-save')!;
const settingsCloseBtn = document.getElementById('settings-close')!;

async function loadFileConfig(): Promise<Partial<DisplayConfig>> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok) return {};
    const j = await res.json();

    // Map public/config.json schema -> DisplayConfig fields
    const cfg: Partial<DisplayConfig> = {};
    if (j?.brightness) {
      if (typeof j.brightness.minThreshold === 'number') cfg.brightnessMinThreshold = j.brightness.minThreshold;
      if (typeof j.brightness.maxThreshold === 'number') cfg.brightnessMaxThreshold = j.brightness.maxThreshold;
    }
    if (j?.textColor) {
      if (typeof j.textColor.min === 'string') cfg.textColorMin = j.textColor.min;
      if (typeof j.textColor.max === 'string') cfg.textColorMax = j.textColor.max;
    }
    return cfg;
  } catch {
    return {};
  }
}

function renderPowerReading(power: PowerReadingEvent): void {
  messageContent.className = '';
  messageContent.style.backgroundColor = '';
  messageContent.style.color = '';

  const watts = power.watts;
  // JST (Asia/Tokyo) で表示
  const timestamp = new Date(power.timestamp).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  // 閾値チェックでスタイル変更（2000W以上で警告色）
  const isHigh = watts >= 2000;
  const colorClass = isHigh ? 'high-power' : '';

  messageContent.innerHTML = `
    <div class="power-display ${colorClass}">
      <div class="power-row">
        <span class="power-value">${watts.toLocaleString()}</span>
        <span class="power-unit">W</span>
      </div>
      <div class="power-timestamp">${timestamp}</div>
      <div class="power-source">${escapeHtml(power.nickname || '')}</div>
    </div>
  `;
}

function renderMessage(message: DisplayMessage | null): void {
  if (!message) {
    messageContent.innerHTML = '';
    messageContent.className = 'empty';
    return;
  }

  messageContent.className = '';

  if (message.style?.backgroundColor) {
    messageContent.style.backgroundColor = message.style.backgroundColor;
  } else {
    messageContent.style.backgroundColor = '';
  }

  if (message.style?.textColor) {
    messageContent.style.color = message.style.textColor;
  } else {
    messageContent.style.color = '';
  }

  switch (message.type) {
    case 'text':
      const sizeClass = message.style?.fontSize ? `size-${message.style.fontSize}` : '';
      messageContent.innerHTML = `<div class="message-text ${sizeClass}">${escapeHtml(message.content || '')}</div>`;
      break;

    case 'image':
      messageContent.innerHTML = `<img class="message-image" src="${escapeHtml(message.imageUrl || '')}" alt="">`;
      break;

    case 'alert':
      messageContent.innerHTML = `
        <div class="message-alert">
          <h2>${escapeHtml(message.title || 'Alert')}</h2>
          <p>${escapeHtml(message.body || message.content || '')}</p>
        </div>
      `;
      break;

    default:
      messageContent.innerHTML = `<div class="message-text">${escapeHtml(String(message.content || ''))}</div>`;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function checkPWAInstall(): void {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as any).standalone === true;

  if (!isStandalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    const banner = document.createElement('div');
    banner.id = 'install-banner';
    banner.innerHTML = `
      <p>📲 ホーム画面に追加</p>
      <small>共有ボタン → 「ホーム画面に追加」でアプリとして使えます</small>
    `;
    document.body.appendChild(banner);

    setTimeout(() => {
      banner.classList.add('hidden');
    }, 8000);

    banner.addEventListener('click', () => {
      banner.classList.add('hidden');
    });
  }
}

async function bootstrap(): Promise<void> {
  // コントローラー（config.json を最優先のデフォルトとして読み込む）
  const fileConfig = await loadFileConfig();
  const controller = new DisplayController(fileConfig);

  // 設定パネルのオーバーレイ
  let overlay: HTMLDivElement | null = null;

  /**
   * 初期化画面のタップハンドラ
   */
  initScreen.addEventListener('click', async () => {
    try {
      initScreen.querySelector('.init-instruction')!.textContent = '初期化中...';
      await controller.initialize();

      // 画面を切り替え
      initScreen.classList.remove('active');
      displayScreen.classList.add('active');
    } catch (err) {
      console.error('Initialization failed:', err);
      initScreen.querySelector('.init-instruction')!.textContent = '初期化に失敗しました。タップして再試行';
    }
  });

  function hideSettings(): void {
    settingsPanel.classList.add('hidden');
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  function showSettings(): void {
    // 現在の設定を反映
    wsUrlInput.value = controller.wsUrl;
    sseUrlInput.value = controller.sseUrl;
    brightnessModeSelect.value = controller.state.brightnessMode;

    // オーバーレイ
    overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.addEventListener('click', hideSettings);
    document.body.appendChild(overlay);

    settingsPanel.classList.remove('hidden');
  }

  settingsSaveBtn.addEventListener('click', () => {
    controller.updateConfig({
      wsUrl: wsUrlInput.value.trim(),
      sseUrl: sseUrlInput.value.trim(),
      brightnessMode: brightnessModeSelect.value as 'auto' | 'light' | 'dark',
    });

    hideSettings();
  });

  settingsCloseBtn.addEventListener('click', hideSettings);

  /**
   * 長押しで設定パネルを表示
   */
  let longPressTimer: number | null = null;

  displayScreen.addEventListener('touchstart', () => {
    longPressTimer = window.setTimeout(() => {
      showSettings();
    }, 1000);
  });

  displayScreen.addEventListener('touchend', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  displayScreen.addEventListener('touchmove', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  // PC用: 右クリックで設定
  displayScreen.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showSettings();
  });

  /**
   * 状態変更の反映
   */
  controller.onStateChange((state: DisplayState) => {
    // 接続状態（SSE優先、なければWS）
    const connState = state.sseConnected !== 'disconnected'
      ? state.sseConnected
      : state.wsConnected;

    connectionStatus.className = 'status-dot ' + connState;
    connectionStatus.title = {
      connected: '接続中',
      connecting: '接続試行中...',
      disconnected: '切断',
    }[connState];

    // 明るさ
    brightnessValue.textContent = `${Math.round(state.ambientLevel * 100)}%`;

    // 表示優先度: currentPower > currentMessage
    if (state.currentPower) {
      renderPowerReading(state.currentPower);
    } else if (state.currentMessage) {
      renderMessage(state.currentMessage);
    } else {
      messageContent.innerHTML = '';
      messageContent.className = 'empty';
    }
  });

  // ページロード時
  window.addEventListener('load', () => {
    checkPWAInstall();
  });

  // Service Worker 登録
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      console.log('Service Worker registered:', reg.scope);
    }).catch((err) => {
      console.warn('Service Worker registration failed:', err);
    });
  }
}

bootstrap();
