import {
  VoiceRouter,
  GladiaAdapter,
  DeepgramAdapter,
  AssemblyAIAdapter,
  AzureSTTAdapter,
  OpenAIWhisperAdapter,
  SpeechmaticsAdapter,
} from "voice-router-dev";
import type { StreamingSession } from "voice-router-dev";
import { voiceRouterConfig, proxyConfig } from "./config";
import { createLogger } from "./utils";
import { TranscriptLogger, createTranscriptLogger } from "./transcriptLogger";
import { getProcessLogger } from "./processLogger";

const logger = createLogger("TranscriptionClient");
const processLogger = getProcessLogger();

// Transcription client using VoiceRouter SDK for multi-provider support
class TranscriptionClient {
  private router: VoiceRouter;
  private streamingSession: StreamingSession | null = null;
  private onTranscriptionCallback:
    | ((text: string, isFinal: boolean) => void)
    | null = null;
  private currentProvider: string;
  private transcriptLogger: TranscriptLogger | null = null;

  constructor() {
    // Initialize VoiceRouter with configured providers
    this.router = new VoiceRouter(voiceRouterConfig as any);
    this.currentProvider = voiceRouterConfig.defaultProvider;

    // Register all available adapters based on configuration
    const registeredProviders: string[] = [];

    if (voiceRouterConfig.providers.gladia) {
      this.router.registerAdapter(new GladiaAdapter());
      registeredProviders.push("gladia");
    }

    if (voiceRouterConfig.providers.deepgram) {
      this.router.registerAdapter(new DeepgramAdapter());
      registeredProviders.push("deepgram");
    }

    if (voiceRouterConfig.providers.assemblyai) {
      this.router.registerAdapter(new AssemblyAIAdapter());
      registeredProviders.push("assemblyai");
    }

    if (voiceRouterConfig.providers["azure-stt"]) {
      this.router.registerAdapter(new AzureSTTAdapter());
      registeredProviders.push("azure-stt");
    }

    if (voiceRouterConfig.providers["openai-whisper"]) {
      this.router.registerAdapter(new OpenAIWhisperAdapter());
      registeredProviders.push("openai-whisper");
    }

    if (voiceRouterConfig.providers.speechmatics) {
      this.router.registerAdapter(new SpeechmaticsAdapter());
      registeredProviders.push("speechmatics");
    }

    if (registeredProviders.length === 0) {
      logger.error(
        "No transcription providers configured. Please set at least one API key in .env"
      );
    } else {
      logger.info(
        `Initialized VoiceRouter with providers: ${registeredProviders.join(
          ", "
        )}`
      );
      logger.info(`Default provider: ${this.currentProvider}`);
      logger.info(
        `Selection strategy: ${voiceRouterConfig.selectionStrategy}`
      );
    }
  }

  // Initialize a streaming session with the configured provider
  async initSession(provider?: string): Promise<boolean> {
    try {
      // Use specified provider or fall back to default
      const selectedProvider = provider || this.currentProvider;

      logger.info(`Initializing streaming session with provider: ${selectedProvider}`);

      // Initialize transcript logger if enabled
      if (proxyConfig.transcriptLogging.enabled) {
        this.transcriptLogger = createTranscriptLogger(
          proxyConfig.transcriptLogging.outputDir,
          selectedProvider,
          true
        );

        this.transcriptLogger.updateMetadata({
          language: "en",
          sampleRate: 16000,
          encoding: "linear16",
        });

        logger.info(
          `Transcript logging enabled: ${this.transcriptLogger.getSessionInfo().filePath}`
        );
      }

      // Start streaming session with VoiceRouter
      this.streamingSession = await this.router.transcribeStream(
        {
          provider: selectedProvider as any,
          encoding: "linear16",  // SDK handles conversion to provider format
          sampleRate: 16000,
          language: "en",
          interimResults: true,
          channels: 1,
        },
        {
          onTranscript: (event) => {
            // Handle transcript events
            const text = event.text || "";
            const isFinal = event.isFinal || false;

            // Log ALL transcript events to console for debugging
            logger.info(
              `📝 Transcript from ${selectedProvider} ${isFinal ? "(FINAL)" : "(partial)"}: "${text}"`
            );

            processLogger?.info(
              `Received transcript from ${selectedProvider}`,
              "TranscriptionClient",
              {
                text: text || "(empty)",
                isFinal,
                textLength: text.length,
                speaker: event.speaker,
                confidence: event.confidence
              }
            );

            // Log to file
            if (this.transcriptLogger) {
              this.transcriptLogger.logTranscript(
                text,
                isFinal,
                event.speaker?.toString(),
                event.confidence
              );
            }

            // Call the registered callback
            if (this.onTranscriptionCallback) {
              this.onTranscriptionCallback(text, isFinal);
            }
          },
          onError: (error) => {
            logger.error(`❌ Transcription ERROR from ${selectedProvider}:`, error);
            processLogger?.error(
              `Transcription error from ${selectedProvider}`,
              "TranscriptionClient",
              { error: JSON.stringify(error) }
            );
          },
          onOpen: () => {
            logger.info(`✅ WebSocket CONNECTED to ${selectedProvider} streaming session`);
            processLogger?.info(
              `WebSocket connection opened to ${selectedProvider}`,
              "TranscriptionClient"
            );
          },
          onClose: () => {
            logger.info(`🔌 WebSocket CLOSED from ${selectedProvider}`);
            processLogger?.info(
              `WebSocket connection closed from ${selectedProvider}`,
              "TranscriptionClient"
            );
          },
        }
      );

      this.currentProvider = selectedProvider;
      logger.info(`Streaming session initialized successfully`);
      return true;
    } catch (error: any) {
      logger.error("Failed to initialize streaming session:", error.message);
      if (error.response?.data) {
        logger.error(
          "API error details:",
          JSON.stringify(error.response.data, null, 2)
        );
      }
      return false;
    }
  }

  // Send audio chunk to the transcription provider
  async sendAudioChunk(audioData: Buffer): Promise<boolean> {
    if (!this.streamingSession) {
      logger.warn("⚠️ Streaming session not initialized, ignoring audio chunk");
      processLogger?.error("sendAudioChunk called but streaming session not initialized", "TranscriptionClient");
      return false;
    }

    processLogger?.debug(
      `Sending audio chunk to ${this.currentProvider}`,
      "TranscriptionClient",
      {
        size: audioData.length,
        firstBytes: audioData.slice(0, 16).toString('hex'),
        isBuffer: Buffer.isBuffer(audioData)
      }
    );

    try {
      // Send audio data to the streaming session
      await this.streamingSession.sendAudio({ data: audioData });
      processLogger?.debug(`Audio chunk sent successfully to ${this.currentProvider}`, "TranscriptionClient");
      return true;
    } catch (error: any) {
      logger.error("❌ Error sending audio chunk:", error);
      processLogger?.error(
        `Failed to send audio to ${this.currentProvider}`,
        "TranscriptionClient",
        { error: error.message, stack: error.stack }
      );
      return false;
    }
  }

  // Set callback for transcription results
  onTranscription(callback: (text: string, isFinal: boolean) => void) {
    this.onTranscriptionCallback = callback;
  }

  // End transcription session
  async endSession(): Promise<void> {
    if (this.streamingSession) {
      try {
        await this.streamingSession.close();
        logger.info("Streaming session ended");
      } catch (error) {
        logger.error("Error ending streaming session:", error);
      }
      this.streamingSession = null;
    }

    // End transcript logging session
    if (this.transcriptLogger) {
      this.transcriptLogger.endSession();
      const info = this.transcriptLogger.getSessionInfo();
      logger.info(`Transcript session saved:`);
      logger.info(`  Session ID: ${info.sessionId}`);
      logger.info(`  File: ${info.filePath}`);
      logger.info(`  Duration: ${info.duration.toFixed(2)}s`);
      logger.info(`  Transcripts: ${info.transcriptCount}`);
      this.transcriptLogger = null;
    }
  }

  // Get the VoiceRouter instance for advanced usage
  getRouter(): VoiceRouter {
    return this.router;
  }

  // Get current provider
  getCurrentProvider(): string {
    return this.currentProvider;
  }

  // Get list of registered providers
  getRegisteredProviders(): string[] {
    return this.router.getRegisteredProviders() as string[];
  }

  // Get information about the last transcript session
  getLastTranscriptInfo(): { sessionDir: string; transcriptCount: number; duration: number } | null {
    if (this.transcriptLogger && this.transcriptLogger.isEnabled()) {
      const info = this.transcriptLogger.getSessionInfo();
      return {
        sessionDir: info.sessionDir,
        transcriptCount: info.transcriptCount,
        duration: info.duration,
      };
    }
    return null;
  }
}

// Export with backward-compatible name
export { TranscriptionClient };
export { TranscriptionClient as GladiaClient }; // Backward compatibility alias
