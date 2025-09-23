import { MeetingBaasClient } from "./meetingbaas";
import { TranscriptionProxy } from "./proxy";
import { proxyConfig } from "./config";
import { createLogger } from "./utils";

const logger = createLogger("Main");

// Keep references to all our clients for cleanup
let meetingBaasClient: MeetingBaasClient | null = null;
let proxy: TranscriptionProxy | null = null;

// Graceful shutdown handler
function setupGracefulShutdown() {
  process.on("SIGINT", async () => {
    logger.info("Shutting down gracefully...");

    // Disconnect from MeetingBaas (remove the bot from the meeting)
    if (meetingBaasClient) {
      logger.info("Telling bot to leave the meeting...");
      await meetingBaasClient.disconnect();
    }

    // Close Gladia connections (via proxy)
    if (proxy) {
      logger.info("Closing transcription services...");
      await proxy.shutdown();
    }

    logger.info("Cleanup complete, exiting...");
    process.exit(0);
  });
}

async function main() {
  try {
    logger.info("Starting transcription system...");

    // Create instances
    proxy = new TranscriptionProxy();
    meetingBaasClient = new MeetingBaasClient();

    // Setup graceful shutdown
    setupGracefulShutdown();

    // Extract command line arguments
    const args = process.argv.slice(2);
    const meetingUrl = args[0] || "https://meet.google.com/your-meeting-id";
    const botName = args[1] || "Transcription Bot";
    const webhookUrl = args[2] || `ws://localhost:${proxyConfig.port}`; // WebSocket URL for streaming

    // Connect the bot to the meeting
    const connected = await meetingBaasClient.connect(
      meetingUrl,
      botName,
      webhookUrl
    );

    if (!connected) {
      logger.error("Failed to connect to meeting");
      process.exit(1);
    }

    logger.info("System initialized successfully");
  } catch (error) {
    logger.error("Error initializing system:", error);
    process.exit(1);
  }
}

main();
