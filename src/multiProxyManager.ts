import { ComparisonService } from "./comparisonService";
import { GladiaClient } from "./gladia";
import { proxyConfig } from "./config";
import { createLogger } from "./utils";
import WebSocket from "ws";

const logger = createLogger("MultiProxy");

/**
 * Bot connection tracking
 */
interface BotConnection {
  botId: string;
  botName: string;
  port: number;
  server: WebSocket.Server;
  ws: WebSocket | null;
  gladiaClient: GladiaClient;
  isGladiaActive: boolean;
  currentSpeaker: string | null;
  connectionTime: number;
}

/**
 * Manager for multiple bot connections with comparison capabilities
 * Each bot gets its own WebSocket server on a different port and Gladia session
 */
export class MultiProxyManager {
  private comparisonService: ComparisonService;
  private botConnections: Map<string, BotConnection> = new Map();
  private nextPort: number;
  private botIdCounter: number = 1;

  constructor(basePort: number = proxyConfig.port, outputDir?: string) {
    this.nextPort = basePort;
    this.comparisonService = new ComparisonService(outputDir);

    logger.info(`Multi-Proxy Manager initialized with base port ${basePort}`);
  }

  /**
   * Register a bot for comparison tracking
   * Creates a WebSocket server on the specified port
   * Returns the WebSocket URL the bot should stream to
   */
  async registerBot(botName: string, customPort?: number): Promise<{
    botId: string;
    streamingUrl: string;
    port: number;
  }> {
    const botId = `bot-${this.botIdCounter++}`;
    const port = customPort || this.nextPort++;

    // Initialize Gladia client for this bot
    const gladiaClient = new GladiaClient();
    const gladiaSuccess = await gladiaClient.initSession();

    if (!gladiaSuccess) {
      logger.error(`Failed to initialize Gladia for bot ${botName}`);
      throw new Error(`Failed to initialize Gladia session for ${botName}`);
    }

    // Set up transcription callback with comparison tracking
    gladiaClient.onTranscription((text, isFinal) => {
      this.comparisonService.recordTranscription(botId, text, isFinal);
    });

    // Create WebSocket server for this bot
    const server = new WebSocket.Server({
      host: proxyConfig.host,
      port: port,
    });

    logger.info(`Created WebSocket server on port ${port} for ${botName}`);

    // Handle connections to this bot's server
    server.on("connection", (ws) => {
      logger.info(`${botName} connected to its WebSocket server`);
      this.handleBotConnection(botId, ws);
    });

    // Create bot connection record
    const connection: BotConnection = {
      botId,
      botName,
      port,
      server,
      ws: null,
      gladiaClient,
      isGladiaActive: gladiaSuccess,
      currentSpeaker: null,
      connectionTime: Date.now(),
    };

    this.botConnections.set(botId, connection);
    this.comparisonService.registerBot(botId, botName);

    const streamingUrl = `ws://localhost:${port}`;
    logger.info(`Registered bot: ${botName} (${botId}) -> ${streamingUrl}`);

    return { botId, streamingUrl, port };
  }

  /**
   * Handle WebSocket connection from a bot
   */
  handleBotConnection(botId: string, ws: WebSocket): void {
    const connection = this.botConnections.get(botId);
    if (!connection) {
      logger.error(`Unknown bot ID: ${botId}`);
      ws.close();
      return;
    }

    connection.ws = ws;
    logger.info(`Bot ${connection.botName} connected via WebSocket`);

    // Handle incoming messages (audio chunks)
    ws.on("message", (message) => {
      this.handleBotMessage(botId, message);
    });

    ws.on("close", () => {
      logger.info(`Bot ${connection.botName} disconnected`);
      connection.ws = null;
    });

    ws.on("error", (error) => {
      logger.error(`Bot ${connection.botName} WebSocket error:`, error);
    });
  }

  /**
   * Handle message from a bot (audio or speaker info)
   */
  private handleBotMessage(botId: string, message: Buffer | string): void {
    const connection = this.botConnections.get(botId);
    if (!connection) return;

    try {
      // Try to parse as JSON (speaker info or other metadata)
      if (Buffer.isBuffer(message)) {
        try {
          const jsonStr = message.toString("utf8");
          const jsonData = JSON.parse(jsonStr);

          // Check if it's speaker information
          if (
            Array.isArray(jsonData) &&
            jsonData.length > 0 &&
            "name" in jsonData[0] &&
            "isSpeaking" in jsonData[0]
          ) {
            const speakerInfo = jsonData[0];

            // Only record when speaker starts talking (not when they stop)
            if (
              speakerInfo.isSpeaking &&
              connection.currentSpeaker !== speakerInfo.name
            ) {
              connection.currentSpeaker = speakerInfo.name;
              this.comparisonService.recordSpeakerEvent(
                botId,
                speakerInfo.name,
                true,
                speakerInfo.timestamp
              );

              logger.info(`[${connection.botName}] Speaker: ${speakerInfo.name}`);
            }
          }
        } catch {
          // Not JSON, treat as audio data
          if (connection.isGladiaActive) {
            connection.gladiaClient.sendAudioChunk(message);
          }
        }
      }
    } catch (error) {
      logger.error(`Error handling message from ${connection.botName}:`, error);
    }
  }

  /**
   * Get port for a specific bot
   */
  getBotPort(botId: string): number | null {
    const connection = this.botConnections.get(botId);
    return connection ? connection.port : null;
  }

  /**
   * Get all registered bots
   */
  getBots(): Array<{ botId: string; botName: string; port: number }> {
    return Array.from(this.botConnections.values()).map((conn) => ({
      botId: conn.botId,
      botName: conn.botName,
      port: conn.port,
    }));
  }

  /**
   * Get comparison statistics
   */
  getStats() {
    return this.comparisonService.getStats();
  }

  /**
   * Export comparison results to JSON
   */
  async exportComparison(): Promise<string> {
    return await this.comparisonService.exportToJSON();
  }

  /**
   * Shutdown all connections and export final results
   */
  async shutdown(): Promise<void> {
    logger.info("Shutting down Multi-Proxy Manager...");

    // Export final comparison results
    try {
      const filepath = await this.exportComparison();
      logger.info(`Final comparison results saved to: ${filepath}`);
    } catch (error) {
      logger.error("Failed to export comparison results:", error);
    }

    // Close all bot connections and servers
    for (const [botId, connection] of this.botConnections.entries()) {
      if (connection.isGladiaActive) {
        logger.info(`Closing Gladia session for ${connection.botName}...`);
        connection.gladiaClient.endSession();
        connection.isGladiaActive = false;
      }

      if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close();
      }

      // Close the WebSocket server
      connection.server.close(() => {
        logger.info(`WebSocket server for ${connection.botName} closed`);
      });
    }

    logger.info("Multi-Proxy Manager shutdown complete");
  }
}
