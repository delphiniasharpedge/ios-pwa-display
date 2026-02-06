/**
 * Sound Manager - 通知音を再生する
 * 
 * iOS Safari では AudioContext をユーザージェスチャー内で
 * 初期化する必要がある。unlock() を最初のタップで呼ぶこと。
 */

export class SoundManager {
  private audioContext: AudioContext | null = null;
  private sounds = new Map<string, AudioBuffer>();
  private playing = new Set<string>();
  private _unlocked = false;

  isSpeaking(): boolean {
    try {
      return !!window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending);
    } catch {
      return false;
    }
  }

  private primeSpeech(): void {
    if (!('speechSynthesis' in window)) return;
    try {
      // Load voices list on user gesture.
      window.speechSynthesis.getVoices();
      // Some iOS versions require speak to be called once after a gesture.
      const u = new SpeechSynthesisUtterance('');
      u.lang = 'ja-JP';
      u.volume = 0;
      window.speechSynthesis.speak(u);
      window.setTimeout(() => {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // ignore
        }
      }, 50);
    } catch {
      // ignore
    }
  }

  announce(text: string): void {
    if (!this._unlocked) {
      console.warn('[SoundManager] Not unlocked yet');
      return;
    }
    if (!text || !text.trim()) return;
    if (!('speechSynthesis' in window)) {
      console.warn('[SoundManager] speechSynthesis not available');
      return;
    }

    // Avoid overlapping announcements.
    if (this.isSpeaking()) return;

    try {
      // Cancel any queued utterances.
      window.speechSynthesis.cancel();

      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      u.rate = 1.0;
      u.pitch = 1.0;
      u.volume = 1.0;

      // Prefer a ja-JP voice if available.
      const voices = window.speechSynthesis.getVoices?.() || [];
      const ja = voices.find(v => v.lang?.toLowerCase?.().startsWith('ja'));
      if (ja) u.voice = ja;

      window.speechSynthesis.speak(u);
    } catch (err) {
      console.warn('[SoundManager] Failed to announce:', err);
    }
  }

  // 内蔵サウンド（短い音）
  private builtinSounds: Record<string, string> = {
    // シンプルなビープ音（440Hz, 0.1秒）
    default: this.generateBeepDataUrl(440, 0.1),
    // アラート音（880Hz, 0.2秒）
    alert: this.generateBeepDataUrl(880, 0.2),
    // チャイム（耳に入りやすい音源へ差し替え）
    chime: '/sounds/mixkit-alarm-clock-beep.wav',
    // 音声アナウンス（macOS sayで生成）
    voice_high_wattage_ja: '/voice/high-wattage-ja.wav',
  };

  get unlocked(): boolean {
    return this._unlocked;
  }

  /**
   * ビープ音のデータURLを生成
   */
  private generateBeepDataUrl(frequency: number, duration: number): string {
    const sampleRate = 22050;
    const numSamples = Math.floor(sampleRate * duration);
    const buffer = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      // サイン波 + エンベロープ（フェードイン/アウト）
      const envelope = Math.min(1, Math.min(t * 20, (duration - t) * 20));
      buffer[i] = Math.sin(2 * Math.PI * frequency * t) * envelope * 0.3;
    }

    return this.float32ToWavDataUrl(buffer, sampleRate);
  }

  /**
   * Float32Array を WAV データURLに変換
   */
  private float32ToWavDataUrl(samples: Float32Array, sampleRate: number): string {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    // WAV ヘッダー
    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // モノラル
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    // サンプルデータ
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    const blob = new Blob([buffer], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
  }

  /**
   * AudioContext をアンロック（ユーザージェスチャー内で呼ぶ）
   */
  async unlock(): Promise<void> {
    if (this._unlocked) return;

    try {
      // AudioContext を作成
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass();

      // iOS Safari: 無音を再生してアンロック
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      const buffer = this.audioContext.createBuffer(1, 1, 22050);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.start(0);

      // 内蔵サウンドをロード
      await this.loadBuiltinSounds();

      // iOS Safari/PWA: prime speech synthesis on user gesture (best-effort)
      this.primeSpeech();

      this._unlocked = true;
      console.log('[SoundManager] Unlocked');
    } catch (err) {
      console.error('[SoundManager] Failed to unlock:', err);
      throw err;
    }
  }

  /**
   * 内蔵サウンドをロード
   */
  private async loadBuiltinSounds(): Promise<void> {
    for (const [name, url] of Object.entries(this.builtinSounds)) {
      try {
        await this.loadSound(name, url);
      } catch (err) {
        console.warn(`[SoundManager] Failed to load builtin sound "${name}":`, err);
      }
    }
  }

  /**
   * サウンドファイルをロード
   */
  async loadSound(name: string, url: string): Promise<void> {
    if (!this.audioContext) return;

    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      this.sounds.set(name, audioBuffer);
      console.log(`[SoundManager] Loaded sound: ${name}`);
    } catch (err) {
      console.error(`[SoundManager] Failed to load sound "${name}":`, err);
    }
  }

  /**
   * サウンドを再生
   */
  play(name: string): void {
    if (!this.audioContext || !this._unlocked) {
      console.warn('[SoundManager] Not unlocked yet');
      return;
    }

    // Avoid overlapping the same sound (esp. voice).
    if (this.playing.has(name)) {
      return;
    }

    const buffer = this.sounds.get(name);
    if (!buffer) {
      console.warn(`[SoundManager] Sound not found: ${name}`);
      // デフォルトにフォールバック
      const defaultBuffer = this.sounds.get('default');
      if (defaultBuffer) {
        this.playBuffer('default', defaultBuffer);
      }
      return;
    }

    this.playBuffer(name, buffer);
  }

  private playBuffer(name: string, buffer: AudioBuffer): void {
    if (!this.audioContext) return;

    this.playing.add(name);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;

    // Slight gain boost so alerts are more noticeable.
    const gain = this.audioContext.createGain();
    gain.gain.value = 1.6;

    source.connect(gain);
    gain.connect(this.audioContext.destination);

    source.onended = () => {
      this.playing.delete(name);
    };

    source.start(0);
  }
}
