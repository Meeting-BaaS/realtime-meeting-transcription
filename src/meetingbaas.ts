import { createBaasClient } from "@meeting-baas/sdk";
import { apiKeys } from "./config";
import { createLogger } from "./utils";

const logger = createLogger("MeetingBaas");

class MeetingBaasClient {
  private client: ReturnType<typeof createBaasClient>;
  private botId: string | null = null;

  constructor() {
    this.client = createBaasClient({
      api_key: apiKeys.meetingBaas,
    });

    logger.info("Initialized MeetingBaas SDK client");
  }

  /**
   * Generate a unique deduplication key
   */
  private generateDeduplicationKey(botName: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${botName}-${timestamp}-${random}`;
  }

  /**
   * Connect to a meeting via MeetingBaas
   * @param meetingUrl URL of the meeting to join
   * @param botName Name of the bot
   * @param webhookUrl WebSocket URL where MeetingBaas will stream audio
   * @returns Promise that resolves when connected
   */
  async connect(
    meetingUrl: string,
    botName: string,
    webhookUrl?: string
  ): Promise<boolean> {
    try {
      logger.info(`Connecting to meeting: ${meetingUrl}`);

      // Generate a unique deduplication key
      const deduplicationKey = this.generateDeduplicationKey(botName);
      logger.info(`Using deduplication key: ${deduplicationKey}`);

      // Join the meeting using the SDK
      const result = await this.client.joinMeeting({
        bot_name: botName,
        meeting_url: meetingUrl,
        reserved: false,
        deduplication_key: deduplicationKey, // Use unique deduplication key
        // Configure streaming to WebSocket
        streaming: {
          output: webhookUrl, // WebSocket URL for streaming audio output
          audio_frequency: "24khz", // Audio frequency for streaming
        },
      });

      if (result.success) {
        this.botId = result.data.bot_id;
        logger.info(`Bot created with ID: ${this.botId}`);
        logger.info(`API Response: ${JSON.stringify(result.data)}`);
        return true;
      } else {
        logger.error("Failed to join meeting:", result.error);
        return false;
      }
    } catch (error) {
      logger.error("Error connecting to meeting:", error);
      return false;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.botId) {
      try {
        const result = await this.client.leaveMeeting({
          uuid: this.botId,
        });

        if (result.success) {
          logger.info(`Bot ${this.botId} successfully left the meeting`);
        } else {
          logger.error("Error leaving meeting:", result.error);
        }
      } catch (error) {
        logger.error("Error leaving meeting:", error);
      }

      this.botId = null;
    }
  }

  public getBotId(): string | null {
    return this.botId;
  }
}

export { MeetingBaasClient };
