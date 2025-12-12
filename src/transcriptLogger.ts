import * as fs from "fs";
import * as path from "path";
import { createLogger } from "./utils";
import { randomUUID } from "crypto";

const logger = createLogger("TranscriptLogger");

export interface TranscriptEntry {
  timestamp: string;
  text: string;
  isFinal: boolean;
  speaker?: string;
  confidence?: number;
}

export interface SessionMetadata {
  sessionId: string;
  startTime: string;
  endTime?: string;
  provider: string;
  language?: string;
  sampleRate?: number;
  encoding?: string;
}

export class TranscriptLogger {
  private baseOutputDir!: string;
  private sessionDir!: string;
  private sessionId!: string;
  private sessionUUID!: string;
  private sessionStartTime!: Date;
  private transcriptEntries: TranscriptEntry[] = [];
  private finalTranscripts: string[] = [];
  private metadata!: SessionMetadata;
  private transcriptFilePath!: string;
  private rawLogFilePath!: string;
  private rawLogStream: fs.WriteStream | null = null;
  private enabled: boolean;

  constructor(
    outputDir: string,
    provider: string = "unknown",
    enabled: boolean = true
  ) {
    this.enabled = enabled;
    if (!this.enabled) {
      return;
    }

    this.baseOutputDir = outputDir;
    this.sessionUUID = randomUUID();
    this.sessionId = this.generateSessionId();
    this.sessionStartTime = new Date();

    this.metadata = {
      sessionId: this.sessionId,
      startTime: this.sessionStartTime.toISOString(),
      provider,
    };

    // Create session-specific directory: sessions/YYYYMMDD_HHMMSS_uuid/
    const timestamp = this.formatTimestamp(this.sessionStartTime);
    const sessionFolderName = `${timestamp}_${this.sessionUUID}`;
    this.sessionDir = path.join(
      this.baseOutputDir,
      "sessions",
      sessionFolderName
    );

    // Create session directory
    this.ensureDirectoryExists(this.sessionDir);

    // Set file paths for this session
    this.transcriptFilePath = path.join(this.sessionDir, "transcript.json");
    this.rawLogFilePath = path.join(this.sessionDir, "raw_logs.txt");

    // Create raw log stream
    this.rawLogStream = fs.createWriteStream(this.rawLogFilePath, {
      flags: "a",
    });

    // Write session header to raw log
    this.logRaw("=".repeat(80));
    this.logRaw(`SESSION STARTED`);
    this.logRaw(`Session UUID: ${this.sessionUUID}`);
    this.logRaw(`Session ID: ${this.sessionId}`);
    this.logRaw(`Provider: ${provider}`);
    this.logRaw(`Start Time: ${this.sessionStartTime.toISOString()}`);
    this.logRaw("=".repeat(80));
    this.logRaw("");

    logger.info(`Session directory created: ${this.sessionDir}`);
    logger.info(`  - UUID: ${this.sessionUUID}`);
    logger.info(`  - Transcript: ${this.transcriptFilePath}`);
    logger.info(`  - Raw logs: ${this.rawLogFilePath}`);
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Format timestamp for filename
   */
  private formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}${month}${day}_${hours}${minutes}${seconds}`;
  }

  /**
   * Ensure directory exists, create if not
   */
  private ensureDirectoryExists(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`Created transcript directory: ${dir}`);
    }
  }

  /**
   * Log a transcript entry
   */
  public logTranscript(
    text: string,
    isFinal: boolean,
    speaker?: string,
    confidence?: number
  ): void {
    if (!this.enabled) {
      return;
    }

    const entry: TranscriptEntry = {
      timestamp: new Date().toISOString(),
      text,
      isFinal,
      speaker,
      confidence,
    };

    this.transcriptEntries.push(entry);

    // Keep track of final transcripts separately for summary
    if (isFinal && text.trim()) {
      this.finalTranscripts.push(text);
    }

    // Log to raw log file
    const time = new Date().toLocaleTimeString();
    const type = isFinal ? "FINAL" : "INTERIM";
    const speakerInfo = speaker ? ` [Speaker: ${speaker}]` : "";
    const confidenceInfo = confidence
      ? ` [Confidence: ${(confidence * 100).toFixed(1)}%]`
      : "";
    this.logRaw(`[${time}] [${type}]${speakerInfo}${confidenceInfo} ${text}`);

    // Write to file after each entry (could be optimized with buffering)
    this.writeToFile();
  }

  /**
   * Log raw message to log file
   */
  private logRaw(message: string): void {
    if (this.rawLogStream) {
      this.rawLogStream.write(message + "\n");
    }
  }

  /**
   * Update session metadata
   */
  public updateMetadata(updates: Partial<SessionMetadata>): void {
    if (!this.enabled) {
      return;
    }

    this.metadata = { ...this.metadata, ...updates };
    this.writeToFile();
  }

  /**
   * Write current session data to file
   */
  private writeToFile(): void {
    try {
      const sessionData = {
        session: {
          uuid: this.sessionUUID,
          id: this.sessionId,
          directory: this.sessionDir,
        },
        metadata: this.metadata,
        statistics: {
          totalEntries: this.transcriptEntries.length,
          finalTranscripts: this.finalTranscripts.length,
          duration: this.getSessionDuration(),
        },
        transcripts: this.transcriptEntries,
        fullText: this.getFinalTranscriptText(),
      };

      fs.writeFileSync(
        this.transcriptFilePath,
        JSON.stringify(sessionData, null, 2),
        "utf-8"
      );
    } catch (error: any) {
      logger.error(`Error writing transcript file: ${error.message}`);
    }
  }

  /**
   * Get session duration in seconds
   */
  private getSessionDuration(): number {
    return (Date.now() - this.sessionStartTime.getTime()) / 1000;
  }

  /**
   * Get final transcript as single text
   */
  private getFinalTranscriptText(): string {
    return this.finalTranscripts.join(" ");
  }

  /**
   * End the session and write final data
   */
  public endSession(): void {
    if (!this.enabled) {
      return;
    }

    this.metadata.endTime = new Date().toISOString();

    // Write final summary to raw log
    this.logRaw("");
    this.logRaw("=".repeat(80));
    this.logRaw(`SESSION ENDED`);
    this.logRaw(`End Time: ${this.metadata.endTime}`);
    this.logRaw(`Duration: ${this.getSessionDuration().toFixed(2)}s`);
    this.logRaw(`Total Transcripts: ${this.finalTranscripts.length}`);
    this.logRaw("=".repeat(80));

    // Close raw log stream
    if (this.rawLogStream) {
      this.rawLogStream.end();
      this.rawLogStream = null;
    }

    this.writeToFile();

    // Also write a plain text version for easy reading
    this.writeTextVersion();

    // Write session summary file
    this.writeSessionSummary();

    logger.info(`Session ended: ${this.sessionId}`);
    logger.info(`Total transcripts: ${this.finalTranscripts.length}`);
    logger.info(`Duration: ${this.getSessionDuration().toFixed(2)}s`);
    logger.info(`Saved to: ${this.sessionDir}`);
  }

  /**
   * Write a plain text version of the transcript
   */
  private writeTextVersion(): void {
    try {
      const textFilePath = path.join(this.sessionDir, "transcript.txt");
      const lines: string[] = [];

      lines.push(`Transcription Session`);
      lines.push(`UUID: ${this.sessionUUID}`);
      lines.push(`Session ID: ${this.sessionId}`);
      lines.push(`Provider: ${this.metadata.provider}`);
      lines.push(`Started: ${this.metadata.startTime}`);
      lines.push(`Ended: ${this.metadata.endTime || "In progress"}`);
      lines.push(`Duration: ${this.getSessionDuration().toFixed(2)}s`);
      lines.push(`Total Transcripts: ${this.finalTranscripts.length}`);
      lines.push("");
      lines.push("=".repeat(80));
      lines.push("");

      // Add timestamped transcripts
      this.transcriptEntries
        .filter((entry) => entry.isFinal)
        .forEach((entry, index) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const speaker = entry.speaker ? `[${entry.speaker}] ` : "";
          const confidence = entry.confidence
            ? ` (${(entry.confidence * 100).toFixed(1)}%)`
            : "";
          lines.push(`[${time}] ${speaker}${entry.text}${confidence}`);
        });

      lines.push("");
      lines.push("=".repeat(80));
      lines.push("");
      lines.push("FULL TRANSCRIPT:");
      lines.push("");
      lines.push(this.getFinalTranscriptText());

      fs.writeFileSync(textFilePath, lines.join("\n"), "utf-8");
    } catch (error: any) {
      logger.error(`Error writing text transcript: ${error.message}`);
    }
  }

  /**
   * Write session summary file
   */
  private writeSessionSummary(): void {
    try {
      const summaryPath = path.join(this.sessionDir, "session_info.txt");
      const lines: string[] = [];

      lines.push("SESSION INFORMATION");
      lines.push("=".repeat(80));
      lines.push("");
      lines.push(`Session UUID:        ${this.sessionUUID}`);
      lines.push(`Session ID:          ${this.sessionId}`);
      lines.push(`Provider:            ${this.metadata.provider}`);
      lines.push(`Start Time:          ${this.metadata.startTime}`);
      lines.push(`End Time:            ${this.metadata.endTime}`);
      lines.push(`Duration:            ${this.getSessionDuration().toFixed(2)} seconds`);
      lines.push(`Language:            ${this.metadata.language || "N/A"}`);
      lines.push(`Sample Rate:         ${this.metadata.sampleRate || "N/A"} Hz`);
      lines.push(`Encoding:            ${this.metadata.encoding || "N/A"}`);
      lines.push("");
      lines.push("STATISTICS");
      lines.push("=".repeat(80));
      lines.push("");
      lines.push(`Total Entries:       ${this.transcriptEntries.length}`);
      lines.push(`Final Transcripts:   ${this.finalTranscripts.length}`);
      lines.push(`Interim Transcripts: ${this.transcriptEntries.length - this.finalTranscripts.length}`);
      lines.push("");
      lines.push("FILES IN THIS SESSION");
      lines.push("=".repeat(80));
      lines.push("");
      lines.push(`- transcript.json    (Structured JSON data)`);
      lines.push(`- transcript.txt     (Human-readable transcript)`);
      lines.push(`- raw_logs.txt       (Real-time logs)`);
      lines.push(`- session_info.txt   (This file)`);

      fs.writeFileSync(summaryPath, lines.join("\n"), "utf-8");
    } catch (error: any) {
      logger.error(`Error writing session summary: ${error.message}`);
    }
  }

  /**
   * Get current session info
   */
  public getSessionInfo(): {
    sessionId: string;
    sessionUUID: string;
    sessionDir: string;
    filePath: string;
    duration: number;
    transcriptCount: number;
  } {
    return {
      sessionId: this.sessionId,
      sessionUUID: this.sessionUUID,
      sessionDir: this.sessionDir,
      filePath: this.transcriptFilePath,
      duration: this.getSessionDuration(),
      transcriptCount: this.finalTranscripts.length,
    };
  }

  /**
   * Check if logging is enabled
   */
  public isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * Create a transcript logger
 */
export function createTranscriptLogger(
  outputDir: string,
  provider: string = "unknown",
  enabled: boolean = true
): TranscriptLogger {
  return new TranscriptLogger(outputDir, provider, enabled);
}
