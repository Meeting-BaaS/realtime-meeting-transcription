import { createBaasClient } from "@meeting-baas/sdk";
import { apiKeys, apiUrls } from "./config";
import { createLogger } from "./utils";

const logger = createLogger("MeetingBaas");

class MeetingBaasClient {
  private client: ReturnType<typeof createBaasClient>;
  private botId: string | null = null;
  private botIds: string[] = []; // Track multiple bots

  constructor() {
    this.client = createBaasClient({
      api_key: apiKeys.meetingBaas,
      base_url: apiUrls.meetingBaas,
    });

    logger.info(`Initialized MeetingBaas SDK client with base URL: ${apiUrls.meetingBaas}`);
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
   * @param streamingUrl WebSocket URL where MeetingBaas will stream audio (wss://)
   * @param webhookUrl HTTP/HTTPS URL for event notifications
   * @returns Promise that resolves when connected
   */
  async connect(
    meetingUrl: string,
    botName: string,
    streamingUrl?: string,
    webhookUrl?: string
  ): Promise<boolean> {
    try {
      logger.info(`Connecting to meeting: ${meetingUrl}`);

      // Generate a unique deduplication key
      const deduplicationKey = this.generateDeduplicationKey(botName);
      logger.info(`Using deduplication key: ${deduplicationKey}`);

      // Convert HTTP/HTTPS URL to WebSocket URL if needed
      let wsUrl = streamingUrl;
      if (streamingUrl) {
        if (streamingUrl.startsWith("https://")) {
          wsUrl = streamingUrl.replace("https://", "wss://");
        } else if (streamingUrl.startsWith("http://")) {
          wsUrl = streamingUrl.replace("http://", "ws://");
        }
        logger.info(`Streaming audio to: ${wsUrl}`);
      }

      // Prepare join meeting configuration
      const joinConfig: any = {
        bot_name: botName,
        meeting_url: meetingUrl,
        reserved: false,
        deduplication_key: deduplicationKey, // Use unique deduplication key
        // Configure streaming to WebSocket
        streaming: {
          output: wsUrl, // WebSocket URL for streaming audio output
          audio_frequency: "16khz", // Audio frequency for streaming (matches Gladia requirements)
        },
      };

      // Add webhook URL - prioritize CLI argument over environment variable
      const finalWebhookUrl = webhookUrl || apiUrls.meetingBaasWebhook;
      if (finalWebhookUrl) {
        joinConfig.webhook_url = finalWebhookUrl;
        logger.info(`Using webhook URL for notifications: ${finalWebhookUrl}`);
      }

      // Join the meeting using the SDK
      const result = await this.client.joinMeeting(joinConfig);

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

  public getBotIds(): string[] {
    return this.botIds;
  }

  /**
   * Connect multiple bots to the same meeting
   * @param meetingUrl URL of the meeting to join
   * @param botConfigs Array of bot configurations (name and streaming URL)
   * @param webhookUrl Optional webhook URL for notifications
   * @returns Promise that resolves with array of bot IDs
   */
  async connectMultiple(
    meetingUrl: string,
    botConfigs: Array<{ name: string; streamingUrl: string }>,
    webhookUrl?: string
  ): Promise<string[]> {
    const botIds: string[] = [];

    logger.info(`Creating ${botConfigs.length} bots for meeting: ${meetingUrl}`);

    for (const config of botConfigs) {
      try {
        const success = await this.connect(
          meetingUrl,
          config.name,
          config.streamingUrl,
          webhookUrl
        );

        if (success && this.botId) {
          botIds.push(this.botId);
          this.botIds.push(this.botId);
          logger.info(`Bot ${config.name} created with ID: ${this.botId}`);
        } else {
          logger.error(`Failed to create bot: ${config.name}`);
        }

        // Small delay between creating bots to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        logger.error(`Error creating bot ${config.name}:`, error);
      }
    }

    logger.info(`Successfully created ${botIds.length}/${botConfigs.length} bots`);
    return botIds;
  }

  /**
   * Disconnect all bots
   */
  async disconnectAll(): Promise<void> {
    logger.info(`Disconnecting ${this.botIds.length} bots...`);

    for (const botId of this.botIds) {
      try {
        const result = await this.client.leaveMeeting({
          uuid: botId,
        });

        if (result.success) {
          logger.info(`Bot ${botId} successfully left the meeting`);
        } else {
          logger.error(`Error leaving meeting for bot ${botId}:`, result.error);
        }
      } catch (error) {
        logger.error(`Error leaving meeting for bot ${botId}:`, error);
      }
    }

    this.botIds = [];
    this.botId = null;
  }
}

export { MeetingBaasClient };
