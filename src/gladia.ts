import {
  VoiceRouter,
  GladiaAdapter,
  DeepgramAdapter,
  AssemblyAIAdapter,
  AzureSTTAdapter,
  OpenAIWhisperAdapter,
  SpeechmaticsAdapter,
} from "voice-router-dev";
import type {
  StreamingSession,
  StreamingOptions,
  StreamingCallbacks,
} from "voice-router-dev";
import { voiceRouterConfig, proxyConfig } from "./config";
import { createLogger } from "./utils";
import { TranscriptLogger, createTranscriptLogger } from "./transcriptLogger";
import { getProcessLogger } from "./processLogger";

const logger = createLogger("TranscriptionClient");
const processLogger = getProcessLogger();

// Providers that support streaming
type StreamingProvider = "gladia" | "deepgram" | "assemblyai";

// Transcription client using VoiceRouter SDK for multi-provider support
class TranscriptionClient {
  private router: VoiceRouter;
  private streamingSession: StreamingSession | null = null;
  private onTranscriptionCallback:
    | ((text: string, isFinal: boolean) => void)
    | null = null;
  private currentProvider: StreamingProvider;
  private transcriptLogger: TranscriptLogger | null = null;

  constructor() {
    // Initialize VoiceRouter with configured providers
    this.router = new VoiceRouter(voiceRouterConfig as any);

    // Register only streaming-capable adapters
    this.registerStreamingAdapters();

    // Get the first available streaming provider or throw
    this.currentProvider = this.getFirstStreamingProvider();

    logger.info(`Initialized with default provider: ${this.currentProvider}`);
    logger.info(
      `Selection strategy: ${voiceRouterConfig.selectionStrategy}`
    );
  }

  /**
   * Register adapters for providers that support streaming
   * SDK will validate capabilities automatically
   */
  private registerStreamingAdapters(): void {
    const adapters = [
      { name: "gladia", Adapter: GladiaAdapter },
      { name: "deepgram", Adapter: DeepgramAdapter },
      { name: "assemblyai", Adapter: AssemblyAIAdapter },
      { name: "azure-stt", Adapter: AzureSTTAdapter },
      { name: "openai-whisper", Adapter: OpenAIWhisperAdapter },
      { name: "speechmatics", Adapter: SpeechmaticsAdapter },
    ] as const;

    const registeredProviders: string[] = [];

    for (const { name, Adapter } of adapters) {
      if (voiceRouterConfig.providers[name]) {
        this.router.registerAdapter(new Adapter());
        registeredProviders.push(name);
      }
    }

    if (registeredProviders.length === 0) {
      throw new Error(
        "No transcription providers configured. Please set at least one API key in .env"
      );
    }

    logger.info(
      `Registered providers: ${registeredProviders.join(", ")}`
    );
  }

  /**
   * Get the first available streaming provider
   * SDK validates provider capabilities automatically
   */
  private getFirstStreamingProvider(): StreamingProvider {
    const registered = this.router.getRegisteredProviders() as string[];
    const streamingProviders: StreamingProvider[] = [
      "gladia",
      "deepgram",
      "assemblyai",
    ];

    // Try configured default first
    const defaultProvider = voiceRouterConfig.defaultProvider as string;
    if (
      streamingProviders.includes(defaultProvider as StreamingProvider) &&
      registered.includes(defaultProvider)
    ) {
      return defaultProvider as StreamingProvider;
    }

    // Otherwise find first streaming provider
    const firstStreaming = registered.find((p) =>
      streamingProviders.includes(p as StreamingProvider)
    ) as StreamingProvider;

    if (!firstStreaming) {
      throw new Error(
        "No streaming providers configured. Add Gladia, Deepgram, or AssemblyAI."
      );
    }

    return firstStreaming;
  }

  private lastError: string = "";

  /**
   * Initialize a streaming session with the configured provider
   * SDK automatically validates provider supports streaming
   */
  async initSession(provider?: StreamingProvider): Promise<boolean> {
    try {
      // Use specified provider or fall back to current validated provider
      const selectedProvider: StreamingProvider =
        provider || this.currentProvider;

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

      // Start streaming session with VoiceRouter (SDK validates capabilities)
      const callbacks: StreamingCallbacks = {
        onOpen: () => {
          logger.info(`✅ WebSocket CONNECTED to ${selectedProvider} streaming session`);
          processLogger?.info(
            `WebSocket connection opened to ${selectedProvider}`,
            "TranscriptionClient"
          );
        },

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

        onClose: (code, reason) => {
          logger.info(`🔌 WebSocket CLOSED from ${selectedProvider}`, { code, reason });
          processLogger?.info(
            `WebSocket connection closed from ${selectedProvider}`,
            "TranscriptionClient",
            { code, reason }
          );
        },
      };

      // SDK will throw clear error if provider doesn't support streaming
      this.streamingSession = await this.router.transcribeStream(
        {
          provider: selectedProvider,
          encoding: "linear16", // SDK handles conversion to provider format
          sampleRate: 16000,
          language: "en",
          interimResults: true,
          channels: 1,
        } as any,
        callbacks
      );

      this.currentProvider = selectedProvider;
      logger.info(`Streaming session initialized successfully`);
      return true;
    } catch (error: any) {
      // SDK throws helpful errors like:
      // "Provider 'azure-stt' does not support streaming transcription"
      const errorMessage = error.message || String(error);
      this.lastError = errorMessage;

      logger.error("Failed to initialize streaming session:", errorMessage);
      if (error.response?.data) {
        const apiError = JSON.stringify(error.response.data, null, 2);
        logger.error("API error details:", apiError);
        this.lastError = `${errorMessage} - API: ${apiError}`;
      }
      return false;
    }
  }

  /**
   * Get the last error message
   */
  getLastError(): string {
    return this.lastError;
  }

  /**
   * Send audio chunk to the transcription provider
   * SDK handles buffering and format conversion automatically
   */
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

  /**
   * Set callback for transcription results
   */
  onTranscription(callback: (text: string, isFinal: boolean) => void): void {
    this.onTranscriptionCallback = callback;
  }

  /**
   * End transcription session and clean up resources
   * SDK handles proper WebSocket closure automatically
   */
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

  /**
   * Check if streaming session is currently active
   */
  isActive(): boolean {
    return this.streamingSession !== null;
  }

  /**
   * Get current session status
   */
  getStatus(): {
    isActive: boolean;
    provider: StreamingProvider | null;
    hasCallback: boolean;
    isLogging: boolean;
  } {
    return {
      isActive: this.streamingSession !== null,
      provider: this.streamingSession ? this.currentProvider : null,
      hasCallback: this.onTranscriptionCallback !== null,
      isLogging: this.transcriptLogger !== null && this.transcriptLogger.isEnabled(),
    };
  }

  /**
   * Get the VoiceRouter instance for advanced usage
   */
  getRouter(): VoiceRouter {
    return this.router;
  }

  /**
   * Get current provider
   */
  getCurrentProvider(): StreamingProvider {
    return this.currentProvider;
  }

  /**
   * Get list of registered providers
   */
  getRegisteredProviders(): string[] {
    return this.router.getRegisteredProviders() as string[];
  }

  /**
   * Get information about the last transcript session
   */
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
