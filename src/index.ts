import { MeetingBaasClient } from "./meetingbaas";
import { TranscriptionProxy } from "./proxy";
import { MultiProxyManager } from "./multiProxyManager";
import { proxyConfig } from "./config";
import { createLogger } from "./utils";

const logger = createLogger("Main");

// Keep references to all our clients for cleanup
let meetingBaasClient: MeetingBaasClient | null = null;
let proxy: TranscriptionProxy | null = null;
let multiProxyManager: MultiProxyManager | null = null;

type Mode = "local" | "remote" | "compare";

// Graceful shutdown handler
function setupGracefulShutdown() {
  process.on("SIGINT", async () => {
    logger.info("Shutting down gracefully...");

    // Disconnect from MeetingBaas (remove the bot from the meeting)
    if (meetingBaasClient) {
      logger.info("Telling remote bot(s) to leave the meeting...");
      const botIds = meetingBaasClient.getBotIds();
      if (botIds.length > 1) {
        await meetingBaasClient.disconnectAll();
      } else {
        await meetingBaasClient.disconnect();
      }
    }

    // Close multi-proxy manager (if in compare mode)
    if (multiProxyManager) {
      logger.info("Closing multi-proxy manager and exporting results...");
      await multiProxyManager.shutdown();
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

function showUsage() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║           🎙️  Real-Time Meeting Transcription                ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");
  console.log("Usage:");
  console.log("  npm run dev:local                                            # Proxy mode: wait for ANY WebSocket connection");
  console.log("  npm run dev:remote <meeting> [name] [streaming] [webhook]    # Managed mode: create MeetingBaas API bot");
  console.log("  npm run dev:compare <meeting> <bot1-name> <bot2-name>        # Compare mode: create 2 bots and compare speaker detection\n");
  console.log("Proxy Mode (accept external audio sources):");
  console.log("  npm run dev:local");
  console.log("  → Starts WebSocket proxy on port 4040");
  console.log("  → Accepts connections from:");
  console.log("     • Local Docker bots");
  console.log("     • Remote streaming servers");
  console.log("     • Any WebSocket client sending audio\n");
  console.log("Managed Mode (MeetingBaas API):");
  console.log("  npm run dev:remote https://meet.google.com/abc-defg-hij");
  console.log("  npm run dev:remote https://meet.google.com/abc-defg-hij \"My Bot\"");
  console.log("  npm run dev:remote https://meet.google.com/abc-defg-hij \"My Bot\" wss://example.ngrok.io");
  console.log("  npm run dev:remote https://meet.google.com/abc-defg-hij \"My Bot\" wss://example.ngrok.io https://example.ngrok.io/webhook");
  console.log("  → Creates bot via MeetingBaas API");
  console.log("  → Bot streams audio to [streaming] (defaults to ws://localhost:4040)");
  console.log("  → Bot sends notifications to [webhook] (optional, can also set MEETING_BAAS_WEBHOOK_URL env var)\n");
  console.log("Compare Mode (speaker detection comparison):");
  console.log("  npm run dev:compare https://meet.google.com/abc-defg-hij \"Bot 1\" \"Bot 2\"");
  console.log("  → Creates 2 bots that join the same meeting");
  console.log("  → Each bot has its own Gladia transcription session");
  console.log("  → Compares speaker detection across both bots");
  console.log("  → Exports comparison results to JSON file on exit\n");
  process.exit(1);
}

async function runLocalMode() {
  logger.info("🔌 PROXY MODE: Waiting for WebSocket connections...");
  logger.info(`📡 Proxy listening on port ${proxyConfig.port}`);
  logger.info(`💡 Connect any audio source to: ws://localhost:${proxyConfig.port}`);
  logger.info(`   Examples:`);
  logger.info(`   • Local Docker bot: ./run_bot_streaming.sh ws://localhost:${proxyConfig.port}`);
  logger.info(`   • Remote server: redirect audio stream to ws://your-ip:${proxyConfig.port}`);
  logger.info(`   • Custom client: connect WebSocket and send 16-bit PCM audio`);

  // Create proxy only
  proxy = new TranscriptionProxy("Local");

  // Setup graceful shutdown
  setupGracefulShutdown();

  logger.info("✅ Proxy ready - waiting for connections...");
}

async function runRemoteMode(
  meetingUrl: string,
  botName: string = "Transcription Bot",
  streamingUrl?: string,
  webhookUrl?: string
) {
  logger.info("☁️  REMOTE MODE: Creating bot via MeetingBaas API...");

  // Create proxy and MeetingBaas client
  proxy = new TranscriptionProxy("Remote");
  meetingBaasClient = new MeetingBaasClient();

  // Setup graceful shutdown
  setupGracefulShutdown();

  // Use custom streaming URL if provided, otherwise default to localhost
  const finalStreamingUrl = streamingUrl || `ws://localhost:${proxyConfig.port}`;
  logger.info(`Using streaming URL: ${finalStreamingUrl}`);

  // Connect the bot to the meeting
  const connected = await meetingBaasClient.connect(
    meetingUrl,
    botName,
    finalStreamingUrl,
    webhookUrl
  );

  if (!connected) {
    logger.error("Failed to create remote bot");
    process.exit(1);
  }

  logger.info("✅ Remote bot created and streaming to proxy");
}

async function runCompareMode(
  meetingUrl: string,
  bot1Name: string = "Bot 1",
  bot2Name: string = "Bot 2",
  webhookUrl?: string
) {
  logger.info("🔀 COMPARE MODE: Creating multiple bots for comparison...");

  // Create multi-proxy manager
  multiProxyManager = new MultiProxyManager(proxyConfig.port);
  meetingBaasClient = new MeetingBaasClient();

  // Setup graceful shutdown
  setupGracefulShutdown();

  try {
    // Register both bots and get their streaming URLs
    logger.info(`Registering ${bot1Name}...`);
    const bot1 = await multiProxyManager.registerBot(bot1Name);

    logger.info(`Registering ${bot2Name}...`);
    const bot2 = await multiProxyManager.registerBot(bot2Name);

    // Create bot configurations
    const botConfigs = [
      { name: bot1Name, streamingUrl: bot1.streamingUrl },
      { name: bot2Name, streamingUrl: bot2.streamingUrl },
    ];

    logger.info(`Creating bots in meeting: ${meetingUrl}`);

    // Create all bots in the meeting
    const botIds = await meetingBaasClient.connectMultiple(
      meetingUrl,
      botConfigs,
      webhookUrl
    );

    if (botIds.length !== botConfigs.length) {
      logger.error(
        `Only ${botIds.length}/${botConfigs.length} bots were created successfully`
      );
    } else {
      logger.info(
        `✅ All ${botIds.length} bots created successfully and streaming`
      );
      logger.info(`📊 Comparison results will be exported to ./comparison_results/ on exit`);
      logger.info(`Press Ctrl+C to stop and export results`);

      // Print current stats every 10 seconds
      setInterval(() => {
        const stats = multiProxyManager?.getStats();
        if (stats) {
          logger.info(
            `📈 Stats: ${stats.bot_count} bots, ${stats.total_speaker_events} speaker events, ${stats.total_transcriptions} transcriptions`
          );
        }
      }, 10000);
    }
  } catch (error) {
    logger.error("Failed to setup compare mode:", error);
    process.exit(1);
  }
}

async function main() {
  try {
    // Parse arguments
    const args = process.argv.slice(2);

    // Check for mode flag
    let mode: Mode = "remote"; // Default to remote for backwards compatibility
    let argIndex = 0;

    if (args[0] === "--local" || args[0] === "-l") {
      mode = "local";
      argIndex = 1;
    } else if (args[0] === "--remote" || args[0] === "-r") {
      mode = "remote";
      argIndex = 1;
    } else if (args[0] === "--compare" || args[0] === "-c") {
      mode = "compare";
      argIndex = 1;
    } else if (args[0] === "--help" || args[0] === "-h") {
      showUsage();
    }

    // Run appropriate mode
    if (mode === "local") {
      await runLocalMode();
    } else if (mode === "compare") {
      // Compare mode requires meeting URL and bot names
      const meetingUrl = args[argIndex];
      const bot1Name = args[argIndex + 1] || "Bot 1";
      const bot2Name = args[argIndex + 2] || "Bot 2";
      const webhookUrl = args[argIndex + 3]; // Optional webhook URL

      if (!meetingUrl || meetingUrl.startsWith("-")) {
        logger.error("Compare mode requires a meeting URL");
        showUsage();
      }

      await runCompareMode(meetingUrl, bot1Name, bot2Name, webhookUrl);
    } else {
      // Remote mode requires meeting URL
      const meetingUrl = args[argIndex];
      const botName = args[argIndex + 1] || "Transcription Bot";
      const streamingUrl = args[argIndex + 2]; // Optional WebSocket streaming URL (wss://)
      const webhookUrl = args[argIndex + 3]; // Optional webhook URL for notifications (https://)

      if (!meetingUrl || meetingUrl.startsWith("-")) {
        logger.error("Remote mode requires a meeting URL");
        showUsage();
      }

      await runRemoteMode(meetingUrl, botName, streamingUrl, webhookUrl);
    }
  } catch (error) {
    logger.error("Error initializing system:", error);
    process.exit(1);
  }
}

main();
