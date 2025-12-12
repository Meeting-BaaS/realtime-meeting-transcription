import * as dotenv from "dotenv";
import { resolve } from "path";

// Load environment variables from .env file
dotenv.config({ path: resolve(__dirname, "../.env") });

// Bot configuration
export const botConfig = {
  host: process.env.BOT_HOST || "0.0.0.0",
  port: parseInt(process.env.BOT_PORT || "8766"),
  audioParams: {
    sampleRate: 16000,
  },
};

// Proxy configuration
export const proxyConfig = {
  host: process.env.PROXY_HOST || "0.0.0.0",
  port: parseInt(process.env.PROXY_PORT || "4040"),
  botUrl: process.env.BOT_URL || "ws://localhost:8766",
  audioParams: {
    sampleRate: 16000, // Match bot's streaming_audio_frequency and Gladia requirements
    channels: 1,
  },
  recording: {
    enabled: process.env.ENABLE_AUDIO_RECORDING === "true",
    outputDir: process.env.AUDIO_OUTPUT_DIR || "./recordings",
  },
  playback: {
    enabled: process.env.ENABLE_AUDIO_PLAYBACK === "true",
  },
  transcriptLogging: {
    enabled: process.env.ENABLE_TRANSCRIPT_LOGGING !== "false", // Enabled by default
    outputDir: process.env.TRANSCRIPT_OUTPUT_DIR || "./transcripts",
  },
};

// API keys
export const apiKeys = {
  meetingBaas: process.env.MEETING_BAAS_API_KEY || "",
  gladia: process.env.GLADIA_API_KEY || "",
  deepgram: process.env.DEEPGRAM_API_KEY || "",
  assemblyai: process.env.ASSEMBLYAI_API_KEY || "",
  azureStt: process.env.AZURE_API_KEY || "",
  openaiWhisper: process.env.OPENAI_API_KEY || "",
  speechmatics: process.env.SPEECHMATICS_API_KEY || "",
};

// API URLs
export const apiUrls = {
  meetingBaas:
    process.env.MEETING_BAAS_API_URL || "https://api.meetingbaas.com",
  meetingBaasWebhook: process.env.MEETING_BAAS_WEBHOOK_URL || undefined,
};

// VoiceRouter configuration
export const voiceRouterConfig = {
  providers: {
    // Only include providers that have API keys configured
    ...(apiKeys.gladia && {
      gladia: { apiKey: apiKeys.gladia },  // v0.1.2+ works correctly
    }),
    ...(apiKeys.deepgram && {
      deepgram: { apiKey: apiKeys.deepgram },
    }),
    ...(apiKeys.assemblyai && {
      assemblyai: { apiKey: apiKeys.assemblyai },
    }),
    ...(apiKeys.azureStt &&
      process.env.AZURE_REGION && {
        "azure-stt": {
          apiKey: apiKeys.azureStt,
          region: process.env.AZURE_REGION,
        },
      }),
    ...(apiKeys.openaiWhisper && {
      "openai-whisper": { apiKey: apiKeys.openaiWhisper },
    }),
    ...(apiKeys.speechmatics && {
      speechmatics: { apiKey: apiKeys.speechmatics },
    }),
  },
  defaultProvider:
    (process.env.TRANSCRIPTION_PROVIDER as any) || "gladia",
  selectionStrategy:
    (process.env.PROVIDER_STRATEGY as "explicit" | "default" | "round-robin") ||
    "default",
};

// Webhook configuration
export const webhookConfig = {
  enabled: process.env.ENABLE_WEBHOOKS === "true",
  port: parseInt(process.env.WEBHOOK_PORT || "5050"),
  host: process.env.WEBHOOK_HOST || "0.0.0.0",
  path: process.env.WEBHOOK_PATH || "/webhooks/transcription",
  secret: process.env.WEBHOOK_SECRET || "",
};

if (!apiKeys.meetingBaas) {
  console.error("MEETING_BAAS_API_KEY is required");
  process.exit(1);
}

// Check if at least one transcription provider is configured
const hasProvider = Object.keys(voiceRouterConfig.providers).length > 0;
if (!hasProvider) {
  console.error(
    "At least one transcription provider API key is required (GLADIA_API_KEY, DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY, etc.)"
  );
  process.exit(1);
}
