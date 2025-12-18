import { createLogger } from "./utils";

const logger = createLogger("AudioViz");

interface TimelineEvent {
  type: "audio" | "transcription_partial" | "transcription_final" | "speaker";
  timestamp: number;
  label: string;
  color: string;
}

interface AudioLevelSample {
  timestamp: number;
  level: number;
}

/**
 * Ultra-fast terminal audio visualizer
 * Shows real-time audio levels and timing info
 */
export class AudioVisualizer {
  private lastUpdateTime: number = 0;
  private audioChunkCount: number = 0;
  private totalBytesReceived: number = 0;
  private startTime: number = Date.now();
  private lastSpeaker: string = "Unknown";
  private isEnabled: boolean = true;
  private timeline: TimelineEvent[] = [];
  private maxTimelineEvents: number = 100;
  private lastAudioReceivedTime: number = 0;
  private lastTranscriptionTime: number = 0;
  private lastDurationUpdate: number = 0;
  private displayDuration: string = "0:00";

  // Audio level history for timeline visualization
  private audioLevelHistory: AudioLevelSample[] = [];
  private readonly AUDIO_HISTORY_SECONDS: number = 30; // Keep last 30 seconds - beautiful waves
  private termWidth: number = 80;
  private termHeight: number = 24;

  // Render throttling to avoid jitter
  private lastRenderTime: number = 0;
  private readonly MIN_RENDER_INTERVAL: number = 100; // 10 FPS - lighter on CPU

  // Dirty tracking - only redraw what changed
  private dirtyPanels: Set<string> = new Set();
  private lastRenderedState: {
    audioLevel?: number;
    transcriptionCount?: number;
    logsCount?: number;
    duration?: string;
    speaker?: string;
    bufferPressure?: number;
  } = {};

  // Recent transcriptions
  private recentTranscriptions: Array<{text: string, isFinal: boolean, timestamp: number}> = [];
  private readonly MAX_TRANSCRIPTIONS: number = 100;

  // Logs buffer for error/debug messages
  private logsBuffer: Array<{text: string, timestamp: number, level: string}> = [];
  private readonly MAX_LOGS: number = 100;
  private logsScrollOffset: number = 0;

  // Detected audio parameters
  private detectedSampleRate: number | null = null;
  private detectedChannels: number = 1;
  private detectedBitDepth: number = 16;
  private audioChunkTimes: number[] = [];
  private isCalculatingParams: boolean = false;

  // Playback buffer pressure
  private bufferPressure: number = 0;

  // Configuration
  private mode: string;
  private port: number;

  // Cached timeline rendering
  private cachedTimeline: string = "";
  private lastTimelineRender: number = 0;

  constructor(mode: string = "Proxy", port: number = 4040) {
    this.mode = mode;
    this.port = port;

    // Clear screen and hide cursor for smooth updates
    if (this.isEnabled) {
      this.updateTerminalSize();
      process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");

      // Update terminal size on resize
      process.stdout.on('resize', () => {
        this.updateTerminalSize();
      });

      // Intercept stderr to capture error logs
      this.interceptStderr();
    }
  }

  /**
   * Intercept stderr to capture logs
   */
  private interceptStderr(): void {
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any, ...args: any[]): boolean => {
      const text = chunk.toString().trim();

      // Filter out high-frequency repetitive warnings that cause jitter
      if (text.includes('buffer full') ||
          text.includes('buffer underflow') ||
          text.includes('coreaudio') ||
          text.includes('Speaker drain event') ||
          text.includes('Flushed')) {
        // Silently ignore these - they're too frequent and cause TUI jitter
        return true;
      }

      // Add other logs to buffer
      this.addLog(text, 'error');

      // DO NOT write to original stderr - we're in TUI mode, everything goes to the logs panel
      // This prevents stderr from interfering with TUI rendering
      return true;
    }) as any;
  }

  /**
   * Add a log entry
   */
  public addLog(text: string, level: string = 'info'): void {
    if (!text || text.length === 0) return;

    this.logsBuffer.push({
      text,
      timestamp: Date.now(),
      level
    });

    // Keep only last MAX_LOGS entries
    if (this.logsBuffer.length > this.MAX_LOGS) {
      this.logsBuffer.shift();
    }
  }

  /**
   * Update terminal dimensions
   */
  private updateTerminalSize(): void {
    this.termWidth = process.stdout.columns || 80;
    this.termHeight = process.stdout.rows || 24;
  }

  /**
   * Calculate audio level from buffer (RMS)
   */
  private calculateAudioLevel(buffer: Buffer): number {
    if (buffer.length === 0) return 0;

    // Treat as 16-bit PCM samples
    let sum = 0;
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i);
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / (buffer.length / 2));
    // Normalize to 0-100 range (16-bit audio max is 32768)
    return Math.min(100, (rms / 32768) * 100);
  }

  /**
   * Create ASCII bar visualization
   */
  private createBar(level: number, width: number = 50): string {
    const filled = Math.floor((level / 100) * width);
    const empty = width - filled;

    let color = "\x1b[32m"; // Green
    if (level > 70) color = "\x1b[31m"; // Red
    else if (level > 40) color = "\x1b[33m"; // Yellow

    return (
      color + "█".repeat(filled) + "\x1b[90m" + "░".repeat(empty) + "\x1b[0m"
    );
  }

  /**
   * Add audio level to history (downsampled for performance)
   * Only keep 1 sample per 100ms (10 samples/sec) instead of every chunk
   */
  private recordAudioLevel(level: number): void {
    const now = Date.now();

    // Downsample: only record if last sample was >100ms ago
    const lastSample = this.audioLevelHistory[this.audioLevelHistory.length - 1];
    if (lastSample && now - lastSample.timestamp < 100) {
      // Update last sample with max level (keep peaks visible)
      lastSample.level = Math.max(lastSample.level, level);
      return;
    }

    this.audioLevelHistory.push({ timestamp: now, level });

    // Remove old samples (older than AUDIO_HISTORY_SECONDS)
    const cutoffTime = now - this.AUDIO_HISTORY_SECONDS * 1000;
    if (this.audioLevelHistory.length > 0 &&
        this.audioLevelHistory[0].timestamp < cutoffTime) {
      // Use splice for batch removal (more efficient than filter)
      let removeCount = 0;
      for (let i = 0; i < this.audioLevelHistory.length; i++) {
        if (this.audioLevelHistory[i].timestamp >= cutoffTime) break;
        removeCount++;
      }
      if (removeCount > 0) {
        this.audioLevelHistory.splice(0, removeCount);
      }
    }
  }


  /**
   * Format duration in seconds
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  }

  /**
   * Format bytes to human readable
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  /**
   * Draw a box border (Desert Mediterranean Evening Theme)
   */
  private drawBox(x: number, y: number, width: number, height: number, title?: string): void {
    // Top border - golden sand color
    process.stdout.write(`\x1b[${y};${x}H\x1b[33m╔${"═".repeat(width - 2)}╗\x1b[0m`);

    // Title if provided - sunset glow
    if (title) {
      const titlePos = Math.floor((width - title.length - 2) / 2);
      process.stdout.write(`\x1b[${y};${x + titlePos}H\x1b[1m\x1b[93m┤ ${title} ├\x1b[0m`);
    }

    // Side borders - golden sand
    for (let i = 1; i < height - 1; i++) {
      process.stdout.write(`\x1b[${y + i};${x}H\x1b[33m║\x1b[0m`);
      process.stdout.write(`\x1b[${y + i};${x + width - 1}H\x1b[33m║\x1b[0m`);
    }

    // Bottom border - golden sand
    process.stdout.write(`\x1b[${y + height - 1};${x}H\x1b[33m╚${"═".repeat(width - 2)}╝\x1b[0m`);
  }

  // Buffer for batched writes (performance optimization)
  private writeBuffer: string[] = [];

  /**
   * Write text at position (buffered for performance)
   */
  private writeAt(x: number, y: number, text: string, color?: string): void {
    const colorCode = color || "\x1b[0m";
    this.writeBuffer.push(`\x1b[${y};${x}H${colorCode}${text}\x1b[0m`);
  }

  /**
   * Flush all buffered writes to stdout (call after rendering panels)
   */
  private flushWrites(): void {
    if (this.writeBuffer.length > 0) {
      process.stdout.write(this.writeBuffer.join(""));
      this.writeBuffer = [];
    }
  }

  /**
   * Add event to timeline
   */
  private addTimelineEvent(
    type: TimelineEvent["type"],
    label: string,
    color: string
  ): void {
    this.timeline.push({
      type,
      timestamp: Date.now(),
      label,
      color,
    });

    // Keep only recent events
    if (this.timeline.length > this.maxTimelineEvents) {
      this.timeline.shift();
    }
  }

  /**
   * Format timestamp relative to start
   */
  private formatRelativeTime(timestamp: number): string {
    const elapsed = timestamp - this.startTime;
    const seconds = elapsed / 1000;
    return `+${seconds.toFixed(2)}s`;
  }

  /**
   * Render the scrolling timeline
   */
  private renderTimeline(): void {
    const width = 64; // Timeline width
    const now = Date.now();
    const timeWindow = 10000; // Show last 10 seconds

    // Get events in time window
    const recentEvents = this.timeline.filter(
      (e) => now - e.timestamp < timeWindow
    );

    console.log("\x1b[1m━━━━━ Event Timeline (last 10s) ━━━━━\x1b[0m");

    if (recentEvents.length === 0) {
      console.log("\x1b[90mWaiting for events...\x1b[0m");
      console.log("");
      return;
    }

    // Show latest 8 events
    const displayEvents = recentEvents.slice(-8);

    for (const event of displayEvents) {
      const timeStr = this.formatRelativeTime(event.timestamp);
      const ageMs = now - event.timestamp;
      const age = ageMs < 1000 ? `${ageMs}ms ago` : `${(ageMs / 1000).toFixed(1)}s ago`;

      let icon = "•";
      switch (event.type) {
        case "audio":
          icon = "🎵";
          break;
        case "transcription_partial":
          icon = "💬";
          break;
        case "transcription_final":
          icon = "📝";
          break;
        case "speaker":
          icon = "👤";
          break;
      }

      console.log(
        `${event.color}${timeStr.padEnd(10)} ${icon} ${event.label.slice(0, 35).padEnd(35)} \x1b[90m${age}\x1b[0m`
      );
    }

    // Show latency between audio and transcription
    if (this.lastAudioReceivedTime > 0 && this.lastTranscriptionTime > 0) {
      const latency = this.lastTranscriptionTime - this.lastAudioReceivedTime;
      if (latency > 0 && latency < 10000) {
        console.log("");
        console.log(
          `\x1b[1m⏱️  Audio→Transcription Latency: \x1b[0m${latency}ms ${latency > 2000 ? "\x1b[31m⚠\x1b[0m" : "\x1b[32m✓\x1b[0m"}`
        );
      }
    }

    console.log("");
  }

  /**
   * Mark panel as needing redraw
   */
  private markDirty(panel: string): void {
    this.dirtyPanels.add(panel);
  }

  /**
   * Check if state changed significantly enough to warrant a redraw
   */
  private hasSignificantChanges(): boolean {
    const currentLevel = this.audioLevelHistory[this.audioLevelHistory.length - 1]?.level || 0;

    // Check for significant changes
    if (this.lastRenderedState.audioLevel === undefined ||
        Math.abs(currentLevel - this.lastRenderedState.audioLevel) > 5 ||
        this.lastRenderedState.transcriptionCount !== this.recentTranscriptions.length ||
        this.lastRenderedState.logsCount !== this.logsBuffer.length ||
        this.lastRenderedState.duration !== this.displayDuration ||
        this.lastRenderedState.speaker !== this.lastSpeaker ||
        this.lastRenderedState.bufferPressure !== this.bufferPressure) {
      return true;
    }

    return false;
  }

  /**
   * Render full-screen dashboard (optimized with dirty checking)
   */
  private renderDashboard(): void {
    // Throttle rendering to avoid jitter
    const now = Date.now();
    if (now - this.lastRenderTime < this.MIN_RENDER_INTERVAL) {
      return; // Skip this render
    }

    // Skip render if nothing changed
    if (!this.hasSignificantChanges() && this.dirtyPanels.size === 0) {
      return;
    }

    this.lastRenderTime = now;

    // Update last rendered state
    this.lastRenderedState = {
      audioLevel: this.audioLevelHistory[this.audioLevelHistory.length - 1]?.level || 0,
      transcriptionCount: this.recentTranscriptions.length,
      logsCount: this.logsBuffer.length,
      duration: this.displayDuration,
      speaker: this.lastSpeaker,
      bufferPressure: this.bufferPressure
    };

    // Clear screen (only on full redraw)
    process.stdout.write("\x1b[2J\x1b[H");

    const halfWidth = Math.floor(this.termWidth / 2);
    const thirdHeight = Math.floor(this.termHeight / 3);

    // Top row: Config | Stats (2 panels)
    this.renderConfigPanel(1, 1, halfWidth, thirdHeight);
    this.renderAudioStatsPanel(halfWidth + 1, 1, this.termWidth - halfWidth, thirdHeight);

    // Middle: Audio Timeline (full width)
    this.renderTimelinePanel(1, thirdHeight + 1, this.termWidth, thirdHeight);

    // Bottom row: Transcription (left 50%) | Logs (right 50%)
    const bottomY = thirdHeight * 2 + 1;
    const bottomHeight = this.termHeight - bottomY + 1;
    this.renderTranscriptionPanel(1, bottomY, halfWidth, bottomHeight);
    this.renderLogsPanel(halfWidth + 1, bottomY, this.termWidth - halfWidth, bottomHeight);

    // Flush all buffered writes to stdout in one operation
    this.flushWrites();

    // Clear dirty flags
    this.dirtyPanels.clear();
  }

  /**
   * Render configuration panel
   */
  private renderConfigPanel(x: number, y: number, width: number, height: number): void {
    this.drawBox(x, y, width, height, "⚙️  Configuration");

    this.writeAt(x + 2, y + 2, `Mode:       ${this.mode}`, "\x1b[97m");
    this.writeAt(x + 2, y + 3, `Port:       ${this.port}`, "\x1b[96m");
    this.writeAt(x + 2, y + 4, `Duration:   ${this.displayDuration}`, "\x1b[93m");

    // Show audio format - evening sky colors
    this.writeAt(x + 2, y + 6, `Audio Format:`, "\x1b[93m");
    this.writeAt(x + 2, y + 7, `  Rate:     16kHz`, "\x1b[96m");
    this.writeAt(x + 2, y + 8, `  Channels: ${this.detectedChannels}`, "\x1b[97m");
    this.writeAt(x + 2, y + 9, `  Bit Depth: ${this.detectedBitDepth}-bit`, "\x1b[97m");
  }

  /**
   * Render audio stats panel
   */
  private renderAudioStatsPanel(x: number, y: number, width: number, height: number): void {
    this.drawBox(x, y, width, height, "📊 Audio Statistics");

    const bytesFormatted = this.formatBytes(this.totalBytesReceived);
    const fps = this.lastUpdateTime > 0 ?
      ((Date.now() - this.lastUpdateTime) > 0 ? (1000 / (Date.now() - this.lastUpdateTime)).toFixed(1) : "∞") : "0";

    this.writeAt(x + 2, y + 2, `Chunks:     ${this.audioChunkCount}`, "\x1b[97m");
    this.writeAt(x + 2, y + 3, `Data:       ${bytesFormatted}`, "\x1b[96m");
    this.writeAt(x + 2, y + 4, `Rate:       ${fps} Hz`, "\x1b[96m");
    this.writeAt(x + 2, y + 5, `Speaker:    ${this.lastSpeaker}`, "\x1b[93m");

    // Buffer pressure - orange for terracotta/sunset glow
    const bufferBar = this.renderBufferPressureBar(20);
    const bufferColor = this.bufferPressure > 80 ? "\x1b[91m" : this.bufferPressure > 50 ? "\x1b[33m" : "\x1b[92m";
    this.writeAt(x + 2, y + 7, `Buffer:     ${this.bufferPressure}%`, bufferColor);
    this.writeAt(x + 2, y + 8, bufferBar, bufferColor);
  }

  /**
   * Render buffer pressure bar
   */
  private renderBufferPressureBar(width: number): string {
    const filled = Math.floor((this.bufferPressure / 100) * width);
    const empty = width - filled;
    return "█".repeat(filled) + "░".repeat(empty);
  }

  /**
   * Render audio timeline panel
   */
  private renderTimelinePanel(x: number, y: number, width: number, height: number): void {
    this.drawBox(x, y, width, height, "🎵 Audio Level Timeline (Last 30s)");

    // Get current audio level
    const latestSample = this.audioLevelHistory[this.audioLevelHistory.length - 1];
    const currentLevel = latestSample ? latestSample.level : 0;

    // Render current level - sunset colors
    this.writeAt(x + 2, y + 2, `Current: ${currentLevel.toFixed(1).padStart(5)}%`,
      currentLevel > 60 ? "\x1b[91m" : currentLevel > 30 ? "\x1b[33m" : "\x1b[96m");

    // Render timeline
    const timelineWidth = width - 4;
    const timeline = this.renderAudioTimelineCustomWidth(timelineWidth);
    this.writeAt(x + 2, y + 3, timeline);

    // Time labels - shadow gray
    const timeLabel = `│ ${this.AUDIO_HISTORY_SECONDS}s ago${" ".repeat(timelineWidth - 20)}now │`;
    this.writeAt(x + 2, y + 4, timeLabel, "\x1b[90m");

    // Legend - muted
    this.writeAt(x + 2, y + 5, "░=silent  ▁▃=low  ▅▇=medium  █=loud", "\x1b[90m");
  }

  /**
   * Render transcription panel
   */
  private renderTranscriptionPanel(x: number, y: number, width: number, height: number): void {
    this.drawBox(x, y, width, height, "💬 Live Transcription");

    const contentWidth = width - 4;
    const maxLines = height - 3;
    let line = 2;

    if (this.recentTranscriptions.length === 0) {
      this.writeAt(x + 2, y + line, "Waiting for transcription...", "\x1b[90m");
    } else {
      // Show most recent transcriptions (use all available lines)
      const startIdx = Math.max(0, this.recentTranscriptions.length - maxLines);
      const toShow = this.recentTranscriptions.slice(startIdx);

      for (const trans of toShow) {
        if (line >= height - 1) break;

        const age = ((Date.now() - trans.timestamp) / 1000).toFixed(0);
        const color = trans.isFinal ? "\x1b[97m" : "\x1b[90m";
        const icon = trans.isFinal ? "📝" : "💬";

        // Wrap text if too long
        const prefix = `${icon} [${age}s] `;
        const maxTextWidth = contentWidth - prefix.length;
        const text = trans.text.slice(0, maxTextWidth);

        this.writeAt(x + 2, y + line, prefix + text, color);
        line++;
      }

      // Show scroll indicator if there are more transcriptions - golden
      if (this.recentTranscriptions.length > maxLines) {
        const scrollInfo = `[${toShow.length + startIdx}/${this.recentTranscriptions.length}]`;
        this.writeAt(x + width - scrollInfo.length - 2, y + height - 1, scrollInfo, "\x1b[93m");
      }
    }
  }

  /**
   * Render logs panel with scrolling
   */
  private renderLogsPanel(x: number, y: number, width: number, height: number): void {
    this.drawBox(x, y, width, height, "📋 Logs");

    const contentWidth = width - 4;
    const maxLines = height - 3;
    let line = 2;

    if (this.logsBuffer.length === 0) {
      this.writeAt(x + 2, y + line, "No logs yet...", "\x1b[90m");
    } else {
      // Show most recent logs (scrollable from bottom)
      const startIdx = Math.max(0, this.logsBuffer.length - maxLines - this.logsScrollOffset);
      const endIdx = Math.min(this.logsBuffer.length, startIdx + maxLines);
      const toShow = this.logsBuffer.slice(startIdx, endIdx);

      for (const log of toShow) {
        if (line >= height - 1) break;

        // Color by level - check for critical errors first
        let color = "\x1b[90m";
        let icon = "ℹ️";

        const textLower = log.text.toLowerCase();

        // Critical errors (red) - transcription failures, session errors, API errors
        if (textLower.includes('session is closed') ||
            textLower.includes('duration violation') ||
            textLower.includes('cannot send audio') ||
            textLower.includes('websocket closed') ||
            textLower.includes('failed to initialize') ||
            textLower.includes('buffer underflow') ||
            textLower.includes('coreaudio') ||
            textLower.includes('401') ||
            textLower.includes('deprecated') ||
            textLower.includes('critical') ||
            log.level === 'critical') {
          color = "\x1b[91m"; // Bright red for critical errors
          icon = "🔴";
        }
        // Regular errors/warnings (yellow)
        else if (log.level === 'error' || textLower.includes('error') || textLower.includes('warning')) {
          color = "\x1b[33m"; // Yellow for warnings/errors
          icon = "⚠️";
        }

        // Truncate log text to fit
        const logText = log.text.slice(0, contentWidth - 3);
        this.writeAt(x + 2, y + line, `${icon} ${logText}`, color);
        line++;
      }

      // Show scroll indicator if there are more logs - golden
      if (this.logsBuffer.length > maxLines) {
        const scrollInfo = `[${endIdx}/${this.logsBuffer.length}]`;
        this.writeAt(x + width - scrollInfo.length - 2, y + height - 1, scrollInfo, "\x1b[93m");
      }
    }
  }

  /**
   * Render audio timeline with custom width (cached for performance)
   * Only recalculates every 200ms instead of every frame
   */
  private renderAudioTimelineCustomWidth(width: number): string {
    const now = Date.now();

    // Return cached timeline if recent enough (200ms cache)
    if (this.cachedTimeline && now - this.lastTimelineRender < 200) {
      return this.cachedTimeline;
    }

    if (this.audioLevelHistory.length === 0) {
      this.cachedTimeline = "\x1b[90m" + "░".repeat(width) + "\x1b[0m";
      this.lastTimelineRender = now;
      return this.cachedTimeline;
    }

    const timeSpan = this.AUDIO_HISTORY_SECONDS * 1000;
    const bucketSize = timeSpan / width;

    const buckets: number[] = new Array(width).fill(0);

    // Batch character lookups for faster rendering
    const chars = ["░", "▁", "▃", "▅", "▇", "█"];
    const colors = ["\x1b[90m", "\x1b[96m", "\x1b[96m", "\x1b[93m", "\x1b[33m", "\x1b[91m"];

    for (const sample of this.audioLevelHistory) {
      const age = now - sample.timestamp;
      const bucketIndex = Math.floor((width - 1) - (age / bucketSize));

      if (bucketIndex >= 0 && bucketIndex < width) {
        buckets[bucketIndex] = Math.max(buckets[bucketIndex], sample.level);
      }
    }

    // Build timeline string in one pass
    const parts: string[] = [];
    for (let i = 0; i < buckets.length; i++) {
      const level = buckets[i];
      let idx = 0;

      if (level >= 80) idx = 5;
      else if (level >= 60) idx = 4;
      else if (level >= 40) idx = 3;
      else if (level >= 20) idx = 2;
      else if (level > 0) idx = 1;

      parts.push(colors[idx] + chars[idx] + "\x1b[0m");
    }

    this.cachedTimeline = parts.join("");
    this.lastTimelineRender = now;
    return this.cachedTimeline;
  }

  /**
   * Async detection of audio parameters from incoming buffers
   * NOTE: This is "async" in the sense that heavy calculations are deferred via setImmediate(),
   * allowing the event loop to process other tasks first. The calculations themselves (~50 numbers)
   * are so lightweight (<1ms) that they won't cause audio pipeline delays.
   */
  private detectAudioParameters(buffer: Buffer, timestamp: number): void {
    // Fast synchronous tracking - negligible overhead
    this.audioChunkTimes.push(timestamp);
    if (this.audioChunkTimes.length > 50) {
      this.audioChunkTimes.shift();
    }

    // Defer calculation to avoid blocking audio processing
    if (this.audioChunkTimes.length >= 20 && !this.detectedSampleRate && !this.isCalculatingParams) {
      this.isCalculatingParams = true;

      // Use setImmediate() to defer to next event loop iteration
      // This allows audio chunks to be processed first
      setImmediate(() => {
        try {
          // Calculate average time between chunks (simple loop, ~20-50 iterations)
          const timeDiffs: number[] = [];
          for (let i = 1; i < this.audioChunkTimes.length; i++) {
            timeDiffs.push(this.audioChunkTimes[i] - this.audioChunkTimes[i - 1]);
          }

          const avgChunkIntervalMs = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
          const avgChunkSize = this.totalBytesReceived / this.audioChunkCount;

          // Calculate sample rate from timing data
          const bytesPerSample = this.detectedBitDepth / 8 * this.detectedChannels;
          const samplesPerChunk = avgChunkSize / bytesPerSample;
          const chunksPerSecond = 1000 / avgChunkIntervalMs;
          const calculatedSampleRate = Math.round(samplesPerChunk * chunksPerSecond);

          // Snap to common sample rates (8 comparisons)
          const commonRates = [8000, 16000, 22050, 24000, 32000, 44100, 48000];
          const closest = commonRates.reduce((prev, curr) =>
            Math.abs(curr - calculatedSampleRate) < Math.abs(prev - calculatedSampleRate) ? curr : prev
          );

          this.detectedSampleRate = closest;
        } catch (e) {
          // Calculation failed, will retry on next opportunity
        } finally {
          this.isCalculatingParams = false;
        }
      });
    }
  }

  /**
   * Update the display with new audio data
   */
  public update(audioBuffer: Buffer, speaker?: string, bufferPressure?: number): void {
    if (!this.isEnabled) return;

    const now = Date.now();
    const latency = now - this.lastUpdateTime;
    this.lastUpdateTime = now;
    this.audioChunkCount++;
    this.totalBytesReceived += audioBuffer.length;
    this.lastAudioReceivedTime = now;

    if (speaker) {
      this.lastSpeaker = speaker;
    }

    // Update buffer pressure
    if (bufferPressure !== undefined) {
      this.bufferPressure = bufferPressure;
    }

    // Calculate audio level
    const level = this.calculateAudioLevel(audioBuffer);

    // Record audio level in history for timeline
    this.recordAudioLevel(level);

    // Async detection of audio parameters
    this.detectAudioParameters(audioBuffer, now);

    // Update duration display only once per second for smoothness
    if (now - this.lastDurationUpdate >= 1000) {
      this.displayDuration = this.formatDuration(now - this.startTime);
      this.lastDurationUpdate = now;
    }

    // Render the full dashboard
    this.renderDashboard();
  }

  /**
   * Update speaker info
   */
  public updateSpeaker(speaker: string): void {
    this.lastSpeaker = speaker;

    // Add speaker change to timeline
    this.addTimelineEvent("speaker", `Speaker: ${speaker}`, "\x1b[35m");
  }

  /**
   * Display transcription
   */
  public showTranscription(text: string, isFinal: boolean): void {
    if (!this.isEnabled) return;

    // Track transcription time for latency calculation
    this.lastTranscriptionTime = Date.now();

    // Add to recent transcriptions
    this.recentTranscriptions.push({
      text,
      isFinal,
      timestamp: Date.now()
    });

    // Keep only recent ones
    if (this.recentTranscriptions.length > this.MAX_TRANSCRIPTIONS) {
      this.recentTranscriptions.shift();
    }

    // Render dashboard to show updated transcription
    this.renderDashboard();
  }

  /**
   * Show error message in the TUI
   */
  public showError(errorMessage: string): void {
    if (!this.isEnabled) return;

    // Add error to logs buffer
    this.logsBuffer.push({
      text: `ERROR: ${errorMessage}`,
      timestamp: Date.now(),
      level: 'error'
    });

    // Keep only recent logs
    if (this.logsBuffer.length > this.MAX_LOGS) {
      this.logsBuffer.shift();
    }

    // Render dashboard to show error
    this.renderDashboard();

    // Display prominent error overlay centered on screen
    this.renderErrorOverlay(errorMessage);
  }

  /**
   * Show a critical error that requires immediate attention
   * Shows both in logs (red) and as an overlay
   */
  public showCriticalError(errorMessage: string, showOverlay: boolean = true): void {
    if (!this.isEnabled) return;

    // Add critical error to logs buffer
    this.logsBuffer.push({
      text: `CRITICAL: ${errorMessage}`,
      timestamp: Date.now(),
      level: 'critical'
    });

    // Keep only recent logs
    if (this.logsBuffer.length > this.MAX_LOGS) {
      this.logsBuffer.shift();
    }

    // Render dashboard to show error
    this.renderDashboard();

    // Display prominent error overlay if requested
    if (showOverlay) {
      this.renderErrorOverlay(errorMessage);
    }
  }

  /**
   * Render a prominent error overlay that's impossible to miss
   */
  private renderErrorOverlay(errorMessage: string): void {
    const boxWidth = Math.min(80, this.termWidth - 10);
    const boxHeight = 10;
    const x = Math.floor((this.termWidth - boxWidth) / 2);
    const y = Math.floor((this.termHeight - boxHeight) / 2);

    // Draw error box with red background
    const redBg = "\x1b[41m\x1b[97m\x1b[1m"; // Red background, white text, bold
    const reset = "\x1b[0m";
    const border = "═";
    const vBorder = "║";

    // Top border
    this.writeAt(x, y, `╔${"═".repeat(boxWidth - 2)}╗`, redBg);

    // Title
    const title = "⚠️  CRITICAL ERROR  ⚠️";
    const titlePadding = Math.floor((boxWidth - title.length - 2) / 2);
    this.writeAt(x, y + 1, `${vBorder}${" ".repeat(titlePadding)}${title}${" ".repeat(boxWidth - titlePadding - title.length - 2)}${vBorder}`, redBg);

    // Separator
    this.writeAt(x, y + 2, `╠${"═".repeat(boxWidth - 2)}╣`, redBg);

    // Error message - wrap text if needed
    const maxTextWidth = boxWidth - 6;
    const wrappedLines = this.wrapText(errorMessage, maxTextWidth);

    let lineNum = 3;
    for (const line of wrappedLines.slice(0, 3)) { // Max 3 lines
      const padding = Math.floor((boxWidth - line.length - 2) / 2);
      this.writeAt(x, y + lineNum, `${vBorder}${" ".repeat(padding)}${line}${" ".repeat(boxWidth - padding - line.length - 2)}${vBorder}`, redBg);
      lineNum++;
    }

    // Empty line
    this.writeAt(x, y + lineNum, `${vBorder}${" ".repeat(boxWidth - 2)}${vBorder}`, redBg);
    lineNum++;

    // Shutdown message
    const shutdownMsg = "Bot will exit in 3 seconds...";
    const shutdownPadding = Math.floor((boxWidth - shutdownMsg.length - 2) / 2);
    this.writeAt(x, y + lineNum, `${vBorder}${" ".repeat(shutdownPadding)}${shutdownMsg}${" ".repeat(boxWidth - shutdownPadding - shutdownMsg.length - 2)}${vBorder}`, redBg);
    lineNum++;

    // Bottom border
    this.writeAt(x, y + lineNum, `╚${"═".repeat(boxWidth - 2)}╝`, redBg);

    // Reset colors
    process.stdout.write(reset);

    // Flush immediately so error is visible
    this.flushWrites();
  }

  /**
   * Wrap text to fit within specified width
   */
  private wrapText(text: string, maxWidth: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxWidth) {
        currentLine += (currentLine.length > 0 ? ' ' : '') + word;
      } else {
        if (currentLine.length > 0) {
          lines.push(currentLine);
        }
        currentLine = word;
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [text.substring(0, maxWidth)];
  }

  /**
   * Clean up and restore terminal
   */
  /**
   * Reset visualizer state on connection close
   */
  public reset(): void {
    // Clear screen completely
    process.stdout.write("\x1b[2J\x1b[H");

    // Reset all state
    this.audioChunkCount = 0;
    this.totalBytesReceived = 0;
    this.startTime = Date.now();
    this.lastSpeaker = "Unknown";
    this.audioLevelHistory = [];
    this.recentTranscriptions = [];
    this.displayDuration = "0:00";
    this.detectedSampleRate = null;
    this.audioChunkTimes = [];

    // Display waiting message
    process.stdout.write("\x1b[2J\x1b[H");
    const msg = "\n\n  🔌 Connection closed. Waiting for new connections...\n\n";
    process.stdout.write(msg);
  }

  public cleanup(): void {
    // Show cursor again and clear screen
    process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
    logger.info("Audio visualizer stopped");
  }
}
