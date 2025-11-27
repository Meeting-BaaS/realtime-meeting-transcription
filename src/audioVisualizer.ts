import { createLogger } from "./utils";

const logger = createLogger("AudioViz");

interface TimelineEvent {
  type: "audio" | "transcription_partial" | "transcription_final" | "speaker";
  timestamp: number;
  label: string;
  color: string;
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

  constructor() {
    // Clear screen and hide cursor for smooth updates
    if (this.isEnabled) {
      process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
      this.renderHeader();
    }
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
   * Render the header
   */
  private renderHeader(): void {
    process.stdout.write("\x1b[H"); // Move to top
    console.log(
      "\x1b[1m\x1b[36m╔════════════════════════════════════════════════════════════════╗\x1b[0m"
    );
    console.log(
      "\x1b[1m\x1b[36m║           🎙️  Real-Time Audio Stream Monitor                  ║\x1b[0m"
    );
    console.log(
      "\x1b[1m\x1b[36m╚════════════════════════════════════════════════════════════════╝\x1b[0m"
    );
    console.log("");
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
   * Update the display with new audio data
   */
  public update(audioBuffer: Buffer, speaker?: string): void {
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

    // Add audio event to timeline
    this.addTimelineEvent(
      "audio",
      `Audio received (${audioBuffer.length}B)`,
      "\x1b[36m"
    );

    // Calculate audio level
    const level = this.calculateAudioLevel(audioBuffer);

    // Update duration display only once per second for smoothness
    if (now - this.lastDurationUpdate >= 1000) {
      this.displayDuration = this.formatDuration(now - this.startTime);
      this.lastDurationUpdate = now;
    }

    // Move cursor to line 5 (below header)
    process.stdout.write("\x1b[5;1H");

    // Clear from cursor to end of screen
    process.stdout.write("\x1b[0J");

    // Display info
    const bytesFormatted = this.formatBytes(this.totalBytesReceived);

    console.log(`\x1b[1mSession Duration:\x1b[0m ${this.displayDuration}`);
    console.log(`\x1b[1mCurrent Speaker:\x1b[0m  ${this.lastSpeaker}`);
    console.log(`\x1b[1mAudio Chunks:\x1b[0m     ${this.audioChunkCount}`);
    console.log(`\x1b[1mData Received:\x1b[0m    ${bytesFormatted}`);
    console.log(
      `\x1b[1mChunk Size:\x1b[0m       ${audioBuffer.length} bytes`
    );
    console.log(
      `\x1b[1mLatency:\x1b[0m          ${latency}ms ${latency > 100 ? "\x1b[31m⚠\x1b[0m" : "\x1b[32m✓\x1b[0m"}`
    );
    console.log("");

    // Audio level visualization
    console.log(
      `\x1b[1mAudio Level:\x1b[0m      ${level.toFixed(1).padStart(5)}%`
    );
    console.log(this.createBar(level, 60));
    console.log("");

    // FPS / Update rate
    const fps = latency > 0 ? (1000 / latency).toFixed(1) : "∞";
    console.log(`\x1b[90mUpdate Rate: ${fps} Hz\x1b[0m`);
    console.log("");

    // Render timeline
    this.renderTimeline();
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

    // Add transcription to timeline
    const truncatedText = text.slice(0, 30);
    if (isFinal) {
      this.addTimelineEvent(
        "transcription_final",
        `Final: "${truncatedText}"`,
        "\x1b[32m"
      );
    } else {
      this.addTimelineEvent(
        "transcription_partial",
        `Partial: "${truncatedText}"`,
        "\x1b[33m"
      );
    }

    // Move to bottom area
    process.stdout.write("\x1b[18;1H");
    console.log(
      `\x1b[1m${isFinal ? "📝" : "💬"} Transcription ${isFinal ? "(final)" : "(partial)"}:\x1b[0m`
    );
    console.log(
      `\x1b[${isFinal ? "37" : "90"}m${text.slice(0, 200)}\x1b[0m`
    );
    console.log("");
  }

  /**
   * Clean up and restore terminal
   */
  public cleanup(): void {
    // Show cursor again and clear screen
    process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
    logger.info("Audio visualizer stopped");
  }
}
