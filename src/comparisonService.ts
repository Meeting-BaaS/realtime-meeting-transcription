import * as fs from "fs";
import * as path from "path";
import { createLogger } from "./utils";

const logger = createLogger("Comparison");

/**
 * Speaker event captured from a bot
 */
export interface SpeakerEvent {
  botId: string;
  botName: string;
  speaker: string;
  timestamp: number;
  isSpeaking: boolean;
  transcription?: string;
}

/**
 * Transcription event with metadata
 */
export interface TranscriptionEvent {
  botId: string;
  botName: string;
  text: string;
  isFinal: boolean;
  timestamp: number;
  speaker?: string;
}

/**
 * Bot session data
 */
interface BotSession {
  botId: string;
  botName: string;
  speakerEvents: SpeakerEvent[];
  transcriptionEvents: TranscriptionEvent[];
  currentSpeaker: string | null;
  sessionStartTime: number;
}

/**
 * Comparison result structure
 */
interface ComparisonResult {
  meeting_info: {
    start_time: string;
    duration_seconds: number;
    bot_count: number;
  };
  bots: {
    [botId: string]: {
      bot_name: string;
      speaker_events: SpeakerEvent[];
      speaker_changes: number;
      unique_speakers: string[];
      transcription_count: number;
    };
  };
  comparison: {
    speaker_detection_agreement: number;
    timing_analysis: {
      average_time_difference_ms: number;
      max_time_difference_ms: number;
    };
    speaker_overlap_analysis: {
      common_speakers: string[];
      bot_specific_speakers: {
        [botId: string]: string[];
      };
    };
  };
}

/**
 * Service for comparing transcription and speaker data from multiple bots
 */
export class ComparisonService {
  private sessions: Map<string, BotSession> = new Map();
  private sessionStartTime: number = Date.now();
  private outputDir: string = "./comparison_results";

  constructor(outputDir?: string) {
    if (outputDir) {
      this.outputDir = outputDir;
    }

    // Create output directory if it doesn't exist
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
      logger.info(`Created comparison output directory: ${this.outputDir}`);
    }
  }

  /**
   * Register a new bot session
   */
  registerBot(botId: string, botName: string): void {
    if (this.sessions.has(botId)) {
      logger.warn(`Bot ${botId} already registered, skipping`);
      return;
    }

    this.sessions.set(botId, {
      botId,
      botName,
      speakerEvents: [],
      transcriptionEvents: [],
      currentSpeaker: null,
      sessionStartTime: Date.now(),
    });

    logger.info(`Registered bot: ${botName} (${botId})`);
  }

  /**
   * Record a speaker event
   */
  recordSpeakerEvent(
    botId: string,
    speaker: string,
    isSpeaking: boolean,
    timestamp?: number
  ): void {
    const session = this.sessions.get(botId);
    if (!session) {
      logger.warn(`Bot ${botId} not registered, ignoring speaker event`);
      return;
    }

    const event: SpeakerEvent = {
      botId,
      botName: session.botName,
      speaker,
      timestamp: timestamp || Date.now(),
      isSpeaking,
    };

    session.speakerEvents.push(event);

    if (isSpeaking) {
      session.currentSpeaker = speaker;
    }

    logger.info(`[${session.botName}] Speaker: ${speaker} - ${isSpeaking ? "speaking" : "stopped"}`);
  }

  /**
   * Record a transcription event
   */
  recordTranscription(
    botId: string,
    text: string,
    isFinal: boolean,
    timestamp?: number
  ): void {
    const session = this.sessions.get(botId);
    if (!session) {
      logger.warn(`Bot ${botId} not registered, ignoring transcription`);
      return;
    }

    const event: TranscriptionEvent = {
      botId,
      botName: session.botName,
      text,
      isFinal,
      timestamp: timestamp || Date.now(),
      speaker: session.currentSpeaker || undefined,
    };

    session.transcriptionEvents.push(event);
  }

  /**
   * Calculate speaker detection agreement between bots
   */
  private calculateSpeakerAgreement(): number {
    const botIds = Array.from(this.sessions.keys());
    if (botIds.length < 2) {
      return 100; // Perfect agreement if only one bot
    }

    // Get all unique speakers across all bots
    const allSpeakers = new Set<string>();
    this.sessions.forEach((session) => {
      session.speakerEvents.forEach((event) => {
        if (event.isSpeaking) {
          allSpeakers.add(event.speaker);
        }
      });
    });

    if (allSpeakers.size === 0) {
      return 100; // No speakers detected by any bot
    }

    // Calculate agreement: how many speakers are common across all bots
    let commonSpeakers = 0;
    allSpeakers.forEach((speaker) => {
      const detectedByBots = botIds.filter((botId) => {
        const session = this.sessions.get(botId);
        return session?.speakerEvents.some(
          (event) => event.speaker === speaker && event.isSpeaking
        );
      });

      if (detectedByBots.length === botIds.length) {
        commonSpeakers++;
      }
    });

    return (commonSpeakers / allSpeakers.size) * 100;
  }

  /**
   * Analyze timing differences between bots
   */
  private analyzeTimingDifferences(): {
    average_time_difference_ms: number;
    max_time_difference_ms: number;
  } {
    const botIds = Array.from(this.sessions.keys());
    if (botIds.length < 2) {
      return { average_time_difference_ms: 0, max_time_difference_ms: 0 };
    }

    const timeDifferences: number[] = [];

    // Compare speaker change timing between bots
    const bot1 = this.sessions.get(botIds[0])!;
    const bot2 = this.sessions.get(botIds[1])!;

    bot1.speakerEvents.forEach((event1) => {
      if (!event1.isSpeaking) return;

      // Find closest matching speaker event in bot2
      const matchingEvent = bot2.speakerEvents.find(
        (event2) => event2.speaker === event1.speaker && event2.isSpeaking
      );

      if (matchingEvent) {
        const timeDiff = Math.abs(event1.timestamp - matchingEvent.timestamp);
        timeDifferences.push(timeDiff);
      }
    });

    if (timeDifferences.length === 0) {
      return { average_time_difference_ms: 0, max_time_difference_ms: 0 };
    }

    const avgDiff =
      timeDifferences.reduce((sum, diff) => sum + diff, 0) /
      timeDifferences.length;
    const maxDiff = Math.max(...timeDifferences);

    return {
      average_time_difference_ms: Math.round(avgDiff),
      max_time_difference_ms: Math.round(maxDiff),
    };
  }

  /**
   * Analyze speaker overlap between bots
   */
  private analyzeSpeakerOverlap(): {
    common_speakers: string[];
    bot_specific_speakers: { [botId: string]: string[] };
  } {
    const botIds = Array.from(this.sessions.keys());
    const speakersByBot = new Map<string, Set<string>>();

    // Collect unique speakers per bot
    this.sessions.forEach((session, botId) => {
      const speakers = new Set<string>();
      session.speakerEvents.forEach((event) => {
        if (event.isSpeaking) {
          speakers.add(event.speaker);
        }
      });
      speakersByBot.set(botId, speakers);
    });

    // Find common speakers (detected by all bots)
    const allSpeakers = new Set<string>();
    speakersByBot.forEach((speakers) => {
      speakers.forEach((speaker) => allSpeakers.add(speaker));
    });

    const commonSpeakers: string[] = [];
    allSpeakers.forEach((speaker) => {
      const detectedByAll = botIds.every((botId) =>
        speakersByBot.get(botId)?.has(speaker)
      );
      if (detectedByAll) {
        commonSpeakers.push(speaker);
      }
    });

    // Find bot-specific speakers (only detected by one bot)
    const botSpecificSpeakers: { [botId: string]: string[] } = {};
    this.sessions.forEach((session, botId) => {
      const specificSpeakers: string[] = [];
      speakersByBot.get(botId)?.forEach((speaker) => {
        const detectedByOthers = botIds
          .filter((id) => id !== botId)
          .some((id) => speakersByBot.get(id)?.has(speaker));

        if (!detectedByOthers) {
          specificSpeakers.push(speaker);
        }
      });
      botSpecificSpeakers[botId] = specificSpeakers;
    });

    return {
      common_speakers: commonSpeakers,
      bot_specific_speakers: botSpecificSpeakers,
    };
  }

  /**
   * Generate comparison result
   */
  private generateComparisonResult(): ComparisonResult {
    const duration = (Date.now() - this.sessionStartTime) / 1000;

    // Build bots data
    const botsData: ComparisonResult["bots"] = {};
    this.sessions.forEach((session, botId) => {
      const uniqueSpeakers = new Set<string>();
      session.speakerEvents.forEach((event) => {
        if (event.isSpeaking) {
          uniqueSpeakers.add(event.speaker);
        }
      });

      const speakerChanges = session.speakerEvents.filter(
        (event) => event.isSpeaking
      ).length;

      botsData[botId] = {
        bot_name: session.botName,
        speaker_events: session.speakerEvents,
        speaker_changes: speakerChanges,
        unique_speakers: Array.from(uniqueSpeakers),
        transcription_count: session.transcriptionEvents.filter(
          (e) => e.isFinal
        ).length,
      };
    });

    // Build comparison analysis
    const speakerAgreement = this.calculateSpeakerAgreement();
    const timingAnalysis = this.analyzeTimingDifferences();
    const speakerOverlap = this.analyzeSpeakerOverlap();

    return {
      meeting_info: {
        start_time: new Date(this.sessionStartTime).toISOString(),
        duration_seconds: Math.round(duration),
        bot_count: this.sessions.size,
      },
      bots: botsData,
      comparison: {
        speaker_detection_agreement: Math.round(speakerAgreement * 100) / 100,
        timing_analysis: timingAnalysis,
        speaker_overlap_analysis: speakerOverlap,
      },
    };
  }

  /**
   * Export comparison results to JSON file
   */
  async exportToJSON(): Promise<string> {
    const result = this.generateComparisonResult();

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `comparison_${timestamp}.json`;
    const filepath = path.join(this.outputDir, filename);

    // Write JSON file
    fs.writeFileSync(filepath, JSON.stringify(result, null, 2));

    logger.info(`Comparison results exported to: ${filepath}`);
    return filepath;
  }

  /**
   * Get current session statistics
   */
  getStats(): {
    bot_count: number;
    total_speaker_events: number;
    total_transcriptions: number;
  } {
    let totalSpeakerEvents = 0;
    let totalTranscriptions = 0;

    this.sessions.forEach((session) => {
      totalSpeakerEvents += session.speakerEvents.length;
      totalTranscriptions += session.transcriptionEvents.length;
    });

    return {
      bot_count: this.sessions.size,
      total_speaker_events: totalSpeakerEvents,
      total_transcriptions: totalTranscriptions,
    };
  }

  /**
   * Reset all sessions and start fresh
   */
  reset(): void {
    this.sessions.clear();
    this.sessionStartTime = Date.now();
    logger.info("Comparison service reset");
  }
}
