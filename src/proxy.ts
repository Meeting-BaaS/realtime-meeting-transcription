import WebSocket from "ws";
import { proxyConfig } from "./config";
import { GladiaClient } from "./gladia";
import { createLogger } from "./utils";

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

  constructor() {
    // Single WebSocket server
    this.server = new WebSocket.Server({
      host: proxyConfig.host,
      port: proxyConfig.port,
    });

    this.gladiaClient = new GladiaClient();

    // Set up transcription callback
    this.gladiaClient.onTranscription((text, isFinal) => {
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

    ws.on("close", () => {
      logger.info("MeetingBaas client disconnected");
      this.meetingBaasClients.delete(ws);

      // End Gladia session if last client disconnects
      if (this.meetingBaasClients.size === 0 && this.isGladiaSessionActive) {
        this.gladiaClient.endSession();
        this.isGladiaSessionActive = false;
      }
    });

    ws.on("error", (error) => {
      logger.error("MeetingBaas client error:", error);
    });
  }

  public async shutdown(): Promise<void> {
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
