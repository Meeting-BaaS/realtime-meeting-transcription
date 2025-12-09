import {
  VoiceRouter,
  GladiaAdapter,
  AssemblyAIAdapter,
  DeepgramAdapter,
  AzureSTTAdapter,
  OpenAIWhisperAdapter,
  SpeechmaticsAdapter,
  StreamingSession,
} from "voice-router-dev";
import { apiKeys, transcriptionConfig } from "./config";
import { createLogger } from "./utils";

const logger = createLogger("VoiceRouter");

// Voice Router client for real-time transcription with multi-provider support
class VoiceRouterClient {
  private router: VoiceRouter;
  private streamingSession: StreamingSession | null = null;
  private onTranscriptionCallback:
    | ((text: string, isFinal: boolean) => void)
    | null = null;
  private provider: string;

  constructor(provider?: string) {
    this.provider = provider || transcriptionConfig.defaultProvider;

    // Initialize router with configured providers
    const providers: Record<string, { apiKey: string; region?: string }> = {};

    // Add Gladia if API key is available
    if (apiKeys.gladia) {
      providers.gladia = { apiKey: apiKeys.gladia };
    }

    // Add AssemblyAI if API key is available
    if (apiKeys.assemblyai) {
      providers.assemblyai = { apiKey: apiKeys.assemblyai };
    }

    // Add Deepgram if API key is available
    if (apiKeys.deepgram) {
      providers.deepgram = { apiKey: apiKeys.deepgram };
    }

    // Add Azure STT if API key and region are available
    if (apiKeys.azureStt && apiKeys.azureSttRegion) {
      providers["azure-stt"] = {
        apiKey: apiKeys.azureStt,
        region: apiKeys.azureSttRegion,
      };
    }

    // Add OpenAI Whisper if API key is available
    if (apiKeys.openaiWhisper) {
      providers["openai-whisper"] = { apiKey: apiKeys.openaiWhisper };
    }

    // Add Speechmatics if API key is available
    if (apiKeys.speechmatics) {
      providers.speechmatics = { apiKey: apiKeys.speechmatics };
    }

    if (Object.keys(providers).length === 0) {
      logger.error(
        "No transcription provider API keys found. Please set at least one provider key in .env"
      );
      throw new Error("No transcription provider API keys configured");
    }

    // Validate that the selected provider is available
    if (!providers[this.provider]) {
      logger.warn(
        `Selected provider '${this.provider}' is not configured. Falling back to first available provider.`
      );
      this.provider = Object.keys(providers)[0];
    }

    this.router = new VoiceRouter({
      providers,
      defaultProvider: this.provider,
    });

    // Register adapters for all available providers
    // This allows for dynamic switching and fallback strategies
    Object.keys(providers).forEach((providerName) => {
      switch (providerName) {
        case "gladia":
          this.router.registerAdapter(new GladiaAdapter());
          logger.info("Registered Gladia adapter");
          break;
        case "assemblyai":
          this.router.registerAdapter(new AssemblyAIAdapter());
          logger.info("Registered AssemblyAI adapter");
          break;
        case "deepgram":
          this.router.registerAdapter(new DeepgramAdapter());
          logger.info("Registered Deepgram adapter");
          break;
        case "azure-stt":
          this.router.registerAdapter(new AzureSTTAdapter());
          logger.info("Registered Azure STT adapter");
          break;
        case "openai-whisper":
          this.router.registerAdapter(new OpenAIWhisperAdapter());
          logger.info("Registered OpenAI Whisper adapter");
          break;
        case "speechmatics":
          this.router.registerAdapter(new SpeechmaticsAdapter());
          logger.info("Registered Speechmatics adapter");
          break;
        default:
          logger.warn(`Unknown provider: ${providerName}`);
      }
    });

    logger.info(
      `VoiceRouter initialized with provider: ${this.provider} (Available: ${Object.keys(providers).join(", ")})`
    );
  }

  // Initialize a streaming session
  async initSession(): Promise<boolean> {
    try {
      logger.info(`Initializing streaming session with ${this.provider}...`);

      this.streamingSession = await this.router.transcribeStream(
        {
          provider: this.provider,
          encoding: "linear16", // WAV/PCM
          sampleRate: 16000,
          language: "en",
          interimResults: true, // Enable partial transcripts
        },
        {
          onTranscript: (event) => {
            if (this.onTranscriptionCallback) {
              // Only log final transcripts to avoid console spam
              if (event.isFinal) {
                logger.info(
                  `Transcription ${event.isFinal ? "(final)" : "(partial)"}: ${
                    event.text
                  }`
                );
              }
              this.onTranscriptionCallback(event.text, event.isFinal);
            }
          },
          onError: (error) => {
            logger.error("Streaming transcription error:", error);
          },
        }
      );

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

  // Send audio chunk for transcription
  sendAudioChunk(audioData: Buffer): boolean {
    if (!this.streamingSession) {
      logger.warn("Streaming session not initialized, ignoring audio chunk");
      return false;
    }

    try {
      // Send audio data to the streaming session
      this.streamingSession.sendAudio({ data: audioData });
      return true;
    } catch (error) {
      logger.error("Error sending audio chunk:", error);
      return false;
    }
  }

  // Set callback for transcription results
  onTranscription(callback: (text: string, isFinal: boolean) => void) {
    this.onTranscriptionCallback = callback;
  }

  // End transcription session
  async endSession() {
    if (this.streamingSession) {
      try {
        await this.streamingSession.close();
        logger.info("Streaming session closed successfully");
      } catch (error) {
        logger.error("Error closing streaming session:", error);
      }
      this.streamingSession = null;
    }
  }

  // Get current provider name
  getProvider(): string {
    return this.provider;
  }

  // Switch provider (requires reinitializing the session)
  setProvider(provider: string) {
    if (this.streamingSession) {
      logger.warn(
        "Cannot switch provider while session is active. Please end the current session first."
      );
      return false;
    }
    this.provider = provider;
    logger.info(`Provider switched to: ${provider}`);
    return true;
  }
}

export { VoiceRouterClient };
