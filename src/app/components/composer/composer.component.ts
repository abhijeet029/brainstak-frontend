import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  NgZone,
  OnDestroy,
  Output,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { IntelligenceLevel, IntelligenceOption } from '../../core/models';

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'unsupported';

@Component({
  selector: 'app-composer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './composer.component.html',
  styleUrl: './composer.component.scss',
})
export class ComposerComponent implements AfterViewInit, OnDestroy {
  private readonly collapsedHeight = 34;
  private readonly http = inject(HttpClient);
  private readonly ngZone = inject(NgZone);
  private readonly base = environment.apiUrl + '/v1';

  @Input() disabled = false;
  @Input() showDisclaimer = true;
  @Input() placeholder = 'Ask anything…';
  @Input() intelligence: IntelligenceLevel = 'low';
  @Input() intelligenceOptions: IntelligenceOption[] = [
    { value: 'low', label: 'Low', enabled: true },
    { value: 'medium', label: 'Medium', enabled: false },
    { value: 'high', label: 'High', enabled: false },
  ];
  @Output() send = new EventEmitter<string>();
  @Output() intelligenceChange = new EventEmitter<IntelligenceLevel>();
  @ViewChild('ta') ta!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('waveCanvas', { static: false }) private waveCanvas?: ElementRef<HTMLCanvasElement>;

  text = '';
  menuOpen = false;
  readonly expanded = signal(false);

  // ── Voice state ─────────────────────────────────────────────────────────────
  readonly voiceState = signal<VoiceState>(
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices
      ? 'idle'
      : 'unsupported',
  );

  /** Text in the box before mic was activated — restored on cancel. */
  private textBeforeVoice = '';

  // MediaRecorder
  private recorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private recordingMimeType = '';

  // Audio visualizer
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId: number | null = null;

  @HostListener('document:click')
  closeMenu() { this.menuOpen = false; }

  ngAfterViewInit() {
    this.ta?.nativeElement.focus();
    this.resetHeight();
  }

  canSend(): boolean {
    return !this.disabled && this.text.trim().length > 0;
  }

  setText(t: string) {
    this.text = t;
    setTimeout(() => { this.autoResize(); this.ta?.nativeElement.focus(); });
  }

  autoResize() {
    if (!this.ta) return;
    const el = this.ta.nativeElement;
    el.style.height = 'auto';
    if (!this.text.trim()) {
      this.expanded.set(false);
      this.resetHeight();
      return;
    }
    const nextHeight = Math.min(Math.max(el.scrollHeight, this.collapsedHeight), 140);
    el.style.height = nextHeight + 'px';
    this.expanded.set(nextHeight > this.collapsedHeight + 18);
  }

  onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (this.canSend()) this.onSubmit(e);
    }
  }

  onSubmit(e: Event) {
    e.preventDefault();
    if (!this.canSend()) return;
    this.abortVoice();
    const t = this.text.trim();
    this.text = '';
    this.expanded.set(false);
    this.autoResize();
    this.send.emit(t);
  }

  ngOnDestroy() { this.abortVoice(); }

  // ── Voice: public actions ────────────────────────────────────────────────────

  toggleVoice() {
    if (this.disabled || this.voiceState() === 'unsupported') return;
    this.voiceState() === 'listening' ? this.confirmVoice() : this.startVoice();
  }

  /** Stop + discard — restore original text. */
  cancelVoice() {
    const saved = this.textBeforeVoice;
    this.abortVoice();
    this.text = saved;
    setTimeout(() => { this.autoResize(); this.ta?.nativeElement.focus(); });
  }

  /** Stop + transcribe → insert text. */
  confirmVoice() {
    if (!this.recorder || this.recorder.state === 'inactive') return;
    this.voiceState.set('transcribing');
    this.stopAudioViz();

    this.recorder.onstop = async () => {
      if (!this.audioChunks.length) {
        this.voiceState.set('idle');
        return;
      }
      const blob = new Blob(this.audioChunks, { type: this.recordingMimeType });
      this.audioChunks = [];
      await this.transcribeBlob(blob);
    };
    this.recorder.stop();
    this.stopMicStream();
  }

  // ── Voice: internals ─────────────────────────────────────────────────────────

  private async startVoice() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.micStream = stream;
      this.textBeforeVoice = this.text;
      this.audioChunks = [];
      this.recordingMimeType = this.bestMimeType();

      this.recorder = new MediaRecorder(stream, {
        mimeType: this.recordingMimeType || undefined,
      });
      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };

      // Start collecting data every 250 ms so we have chunks before stop()
      this.recorder.start(250);
      this.voiceState.set('listening');

      // Start waveform after Angular re-renders the canvas
      setTimeout(() => this.startAudioViz(stream), 80);
    } catch {
      this.voiceState.set('idle');
    }
  }

  /** Immediately stop everything and discard any recording in progress. */
  private abortVoice() {
    this.voiceState.set('idle');
    this.stopAudioViz();
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* ignore */ }
    }
    this.recorder = null;
    this.audioChunks = [];
    this.stopMicStream();
  }

  private stopMicStream() {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
  }

  private bestMimeType(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',   // iOS Safari
      '',
    ];
    return candidates.find((t) => !t || MediaRecorder.isTypeSupported(t)) ?? '';
  }

  private async transcribeBlob(blob: Blob) {
    try {
      const base64 = await this.blobToBase64(blob);
      const res = await firstValueFrom(
        this.http.post<{ text: string }>(`${this.base}/voice/transcribe`, {
          audio: base64,
          mimeType: blob.type || this.recordingMimeType || 'audio/webm',
        }),
      );
      const transcribed = (res?.text ?? '').trim();

      // Run inside NgZone — recorder.onstop fires outside Angular's zone,
      // so assignments here won't trigger change detection otherwise.
      this.ngZone.run(() => {
        if (transcribed) {
          // Voice input should fill the composer, not auto-submit. This lets
          // the user edit the transcript or send it manually.
          this.voiceState.set('idle');
          this.text = [this.textBeforeVoice.trim(), transcribed]
            .filter(Boolean)
            .join(' ')
            .trim();
          setTimeout(() => { this.autoResize(); this.ta?.nativeElement.focus(); });
        } else {
          // Nothing heard — just restore state quietly.
          this.text = this.textBeforeVoice;
          this.voiceState.set('idle');
          setTimeout(() => { this.autoResize(); this.ta?.nativeElement.focus(); });
        }
      });
    } catch {
      this.ngZone.run(() => {
        this.text = this.textBeforeVoice;
        this.voiceState.set('idle');
        setTimeout(() => { this.autoResize(); this.ta?.nativeElement.focus(); });
      });
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        // Strip "data:<mime>;base64," prefix
        resolve(dataUrl.split(',')[1] ?? '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ── Audio visualizer ─────────────────────────────────────────────────────────

  private startAudioViz(stream: MediaStream) {
    const canvas = this.waveCanvas?.nativeElement;
    if (!canvas) return;

    const AC: typeof AudioContext =
      window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
    if (!AC) return;

    try {
      this.audioCtx = new AC();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.75;
      const src = this.audioCtx.createMediaStreamSource(stream);
      src.connect(this.analyser);
      this.drawWave(canvas);
    } catch { /* viz unavailable */ }
  }

  private drawWave(canvas: HTMLCanvasElement) {
    if (!this.analyser) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufLen = this.analyser.frequencyBinCount;
    const data = new Uint8Array(bufLen);

    const frame = () => {
      this.rafId = requestAnimationFrame(frame);
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(data);

      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth * dpr;
      const H = canvas.clientHeight * dpr;
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      ctx.clearRect(0, 0, W, H);

      const BAR_COUNT = 55;
      const BAR_W = Math.max(2, (W / BAR_COUNT) * 0.38);
      const GAP = (W - BAR_COUNT * BAR_W) / (BAR_COUNT + 1);

      for (let i = 0; i < BAR_COUNT; i++) {
        const v = ((data[Math.floor(i * bufLen / BAR_COUNT)] ?? 0)) / 255;
        const barH = Math.max(BAR_W, v * H * 0.82);
        const x = GAP + i * (BAR_W + GAP);
        const y = (H - barH) / 2;
        ctx.fillStyle = getComputedStyle(canvas).color || '#000';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, BAR_W, barH, BAR_W / 2);
        else ctx.rect(x, y, BAR_W, barH);
        ctx.fill();
      }
    };
    frame();
  }

  private stopAudioViz() {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
    this.analyser = null;
  }

  // ── Intelligence menu ─────────────────────────────────────────────────────

  toggleIntelligenceMenu(event: Event) {
    event.stopPropagation();
    if (this.disabled) return;
    this.menuOpen = !this.menuOpen;
  }

  chooseIntelligence(event: Event, option: IntelligenceOption) {
    event.stopPropagation();
    if (!option.enabled) return;
    this.menuOpen = false;
    this.intelligenceChange.emit(option.value);
  }

  selectedIntelligenceOption() {
    return this.intelligenceOptions.find((o) => o.value === this.intelligence) ?? this.intelligenceOptions[0];
  }

  selectedReason() {
    return this.selectedIntelligenceOption()?.reason ?? this.defaultReason(this.intelligence);
  }

  labelFor(option: IntelligenceOption) { return option.label; }

  defaultReason(level: IntelligenceLevel) {
    switch (level) {
      case 'high':   return 'Best for harder reasoning and complex coding tasks.';
      case 'medium': return 'Balanced reasoning depth with controlled quota usage.';
      default:       return 'Preferred by default for speed, cost, and everyday questions.';
    }
  }

  onDraftInput() {}

  private resetHeight() {
    if (this.ta) this.ta.nativeElement.style.height = `${this.collapsedHeight}px`;
  }
}
