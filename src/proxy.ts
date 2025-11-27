import WebSocket from "ws";
import { proxyConfig } from "./config";
import { GladiaClient } from "./gladia";
import { createLogger } from "./utils";
import { AudioVisualizer } from "./audioVisualizer";
import * as fs from "fs";
import * as path from "path";

const logger = createLogger("Proxy");

// Define simple message types to replace protobufs
interface AudioMessage {
  type: "audio";
  data: {
    audio: string; // Base64 encoded audio
    sampleRate: number;
    channels: number;
  };
}

interface TranscriptionMessage {
  type: "transcription";
  data: {
    text: string;
    isFinal: boolean;
    startTime: number;
    endTime: number;
  };
}

interface TextMessage {
  type: "text";
  data: {
    text: string;
  };
}

interface SpeakerInfo {
  name: string;
  id: number;
  timestamp: number;
  isSpeaking: boolean;
}

type Message = AudioMessage | TranscriptionMessage | TextMessage;

// Helper function to safely inspect message content
function inspectMessage(message: Buffer | string | unknown): string {
  try {
    // If it's a buffer, convert to string for inspection
    if (Buffer.isBuffer(message)) {
      // Try to parse as JSON first
      try {
        const jsonStr = message.toString("utf8");
        const json = JSON.parse(jsonStr);
        return `[Buffer as JSON] ${JSON.stringify(json, null, 2)}`;
      } catch {
        // If not JSON, show as hex if it's binary-looking, or as string if not
        const str = message.toString("utf8");
        if (/[\x00-\x08\x0E-\x1F\x80-\xFF]/.test(str)) {
          // Likely binary data, show first 100 bytes as hex
          return `[Binary Buffer] ${message.slice(0, 100).toString("hex")}${
            message.length > 100 ? "..." : ""
          }`;
        } else {
          // Printable string
          return `[String Buffer] ${str.slice(0, 500)}${
            str.length > 500 ? "..." : ""
          }`;
        }
      }
    }

    // If it's already a string
    if (typeof message === "string") {
      // Try to parse as JSON
      try {
        const json = JSON.parse(message);
        return `[String as JSON] ${JSON.stringify(json, null, 2)}`;
      } catch {
        // Plain string
        return `[String] ${message.slice(0, 500)}${
          message.length > 500 ? "..." : ""
        }`;
      }
    }

    // For any other type
    return `[${typeof message}] ${JSON.stringify(message, null, 2)}`;
  } catch (error) {
    return `[Inspection Error] Failed to inspect message: ${error}`;
  }
}

class TranscriptionProxy {
  private server: WebSocket.Server;
  private botClient: WebSocket | null = null;
  private meetingBaasClients: Set<WebSocket> = new Set();
  private gladiaClient: GladiaClient;
  private isGladiaSessionActive: boolean = false;
  private lastSpeaker: string | null = null;
  private audioBuffers: Buffer[] = [];
  private recordingStartTime: number | null = null;
  private audioVisualizer: AudioVisualizer;

  constructor() {
    // Single WebSocket server
    this.server = new WebSocket.Server({
      host: proxyConfig.host,
      port: proxyConfig.port,
    });

    this.gladiaClient = new GladiaClient();
    this.audioVisualizer = new AudioVisualizer();

    // Set up transcription callback
    this.gladiaClient.onTranscription((text, isFinal) => {
      // Show transcription in visualizer
      this.audioVisualizer.showTranscription(text, isFinal);

      // Create a transcription message to send to the bot client
      const transcriptionMsg = {
        type: "transcription",
        data: {
          text: text,
          isFinal: isFinal,
          startTime: Date.now(), // Approximate
          endTime: Date.now(), // Approximate
        },
      };

      // Send the transcription to the bot client
      if (this.botClient && this.botClient.readyState === WebSocket.OPEN) {
        this.botClient.send(JSON.stringify(transcriptionMsg));
      }
    });

    logger.info(
      `Proxy server started on ${proxyConfig.host}:${proxyConfig.port}`
    );

    this.server.on("connection", (ws) => {
      logger.info("New connection established");

      // Determine if this is a bot or MeetingBaas client
      ws.once("message", (message) => {
        try {
          const msg = JSON.parse(message.toString());
          if (msg.type === "register" && msg.client === "bot") {
            this.setupBotClient(ws);
          } else {
            this.setupMeetingBaasClient(ws);
          }
        } catch (error) {
          // If message is not valid JSON, assume it's a MeetingBaas client
          this.setupMeetingBaasClient(ws);
        }
      });
    });
  }

  private setupBotClient(ws: WebSocket) {
    logger.info("Bot client connected");
    this.botClient = ws;

    ws.on("message", (message) => {
      // Log all messages from bot
      logger.info(`Message from bot: ${inspectMessage(message)}`);

      // Forward bot messages to all MeetingBaas clients
      this.meetingBaasClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message.toString());
        }
      });
    });

    ws.on("close", () => {
      logger.info("Bot client disconnected");
      this.botClient = null;
    });

    ws.on("error", (error) => {
      logger.error("Bot client error:", error);
    });
  }

  private setupMeetingBaasClient(ws: WebSocket) {
    logger.info("MeetingBaas client connected");
    this.meetingBaasClients.add(ws);

    // Initialize Gladia session if not already active
    if (!this.isGladiaSessionActive) {
      logger.info("Initializing Gladia transcription session...");
      this.gladiaClient.initSession().then((success) => {
        this.isGladiaSessionActive = success;
        if (success) {
          logger.info("Gladia transcription session ready");
        } else {
          logger.error("Failed to initialize Gladia transcription session");
        }
      });
    }

    // Set recording start time if recording is enabled
    if (proxyConfig.recording.enabled && this.recordingStartTime === null) {
      this.recordingStartTime = Date.now();
      logger.info("Audio recording started");
    }

    ws.on("message", (message) => {
      // Skip logging binary buffers and try to transcribe them
      if (Buffer.isBuffer(message)) {
        // Try to identify if it's audio data
        try {
          const jsonStr = message.toString("utf8");
          const jsonData = JSON.parse(jsonStr);

          // If it's speaker information
          if (
            Array.isArray(jsonData) &&
            jsonData.length > 0 &&
            "name" in jsonData[0] &&
            "isSpeaking" in jsonData[0]
          ) {
            const speakerInfo = jsonData[0] as SpeakerInfo;

            // Only log when a new speaker starts talking (different from the last one)
            // or when we haven't seen any speaker yet
            if (
              speakerInfo.isSpeaking &&
              (this.lastSpeaker === null ||
                this.lastSpeaker !== speakerInfo.name)
            ) {
              // Update our last speaker tracking
              this.lastSpeaker = speakerInfo.name;

              // Update visualizer with new speaker
              this.audioVisualizer.updateSpeaker(speakerInfo.name);

              // Log the new speaker
              logger.info(
                `New speaker: ${speakerInfo.name} (id: ${speakerInfo.id})`
              );
            }

            // For other JSON messages, log as usual without speaker tracking
          } else {
            logger.info(`Message from MeetingBaas: ${inspectMessage(message)}`);
          }
        } catch {
          // Likely audio data, send to Gladia for transcription
          if (this.isGladiaSessionActive) {
            this.gladiaClient.sendAudioChunk(message);
          }

          // Update audio visualizer
          this.audioVisualizer.update(message, this.lastSpeaker || undefined);

          // Store audio buffer if recording is enabled
          if (proxyConfig.recording.enabled) {
            this.audioBuffers.push(Buffer.from(message));
          }
        }
      } else {
        // For non-binary messages, log as usual
        logger.info(`Message from MeetingBaas: ${inspectMessage(message)}`);
      }

      // Forward MeetingBaas messages to bot client
      if (this.botClient && this.botClient.readyState === WebSocket.OPEN) {
        this.botClient.send(message.toString());
      }
    });

    ws.on("close", async () => {
      logger.info("MeetingBaas client disconnected");
      this.meetingBaasClients.delete(ws);

      // Save audio and end Gladia session if last client disconnects
      if (this.meetingBaasClients.size === 0) {
        await this.saveAudioToFile();

        if (this.isGladiaSessionActive) {
          this.gladiaClient.endSession();
          this.isGladiaSessionActive = false;
        }
      }
    });

    ws.on("error", (error) => {
      logger.error("MeetingBaas client error:", error);
    });
  }

  /**
   * Create WAV file header for the audio data
   */
  private createWavHeader(dataLength: number): Buffer {
    const sampleRate = proxyConfig.audioParams.sampleRate;
    const channels = proxyConfig.audioParams.channels;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;

    const header = Buffer.alloc(44);

    // RIFF chunk descriptor
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write("WAVE", 8);

    // fmt sub-chunk
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // Sub-chunk size (16 for PCM)
    header.writeUInt16LE(1, 20); // Audio format (1 for PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data sub-chunk
    header.write("data", 36);
    header.writeUInt32LE(dataLength, 40);

    return header;
  }

  /**
   * Save the concatenated audio to a WAV file
   */
  private async saveAudioToFile(): Promise<void> {
    if (!proxyConfig.recording.enabled || this.audioBuffers.length === 0) {
      return;
    }

    try {
      // Create output directory if it doesn't exist
      const outputDir = proxyConfig.recording.outputDir;
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // Generate filename with timestamp
      const timestamp = this.recordingStartTime || Date.now();
      const filename = `recording_${new Date(timestamp).toISOString().replace(/[:.]/g, "-")}.wav`;
      const filepath = path.join(outputDir, filename);

      // Concatenate all audio buffers
      const audioData = Buffer.concat(this.audioBuffers);
      const wavHeader = this.createWavHeader(audioData.length);

      // Write WAV file
      const wavFile = Buffer.concat([wavHeader, audioData]);
      fs.writeFileSync(filepath, wavFile);

      logger.info(`Audio saved to: ${filepath} (${audioData.length} bytes)`);
    } catch (error) {
      logger.error("Error saving audio file:", error);
    }
  }

  public async shutdown(): Promise<void> {
    // Cleanup visualizer
    this.audioVisualizer.cleanup();

    // Save audio recording if any data was captured
    await this.saveAudioToFile();

    // End the Gladia session if it's active
    if (this.isGladiaSessionActive) {
      logger.info("Ending Gladia transcription session...");
      await this.gladiaClient.endSession();
      this.isGladiaSessionActive = false;
    }

    // Close all client connections
    this.meetingBaasClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    });

    if (this.botClient && this.botClient.readyState === WebSocket.OPEN) {
      this.botClient.close();
    }

    // Close the WebSocket server
    return new Promise((resolve) => {
      this.server.close(() => {
        logger.info("WebSocket server closed");
        resolve();
      });
    });
  }
}

export { TranscriptionProxy };
