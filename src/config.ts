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
};

// API keys for transcription providers
export const apiKeys = {
  meetingBaas: process.env.MEETING_BAAS_API_KEY || "",
  gladia: process.env.GLADIA_API_KEY || "",
  assemblyai: process.env.ASSEMBLYAI_API_KEY || "",
  deepgram: process.env.DEEPGRAM_API_KEY || "",
  azureStt: process.env.AZURE_STT_API_KEY || "",
  azureSttRegion: process.env.AZURE_STT_REGION || "",
  openaiWhisper: process.env.OPENAI_API_KEY || "",
  speechmatics: process.env.SPEECHMATICS_API_KEY || "",
};

// Transcription provider configuration
export const transcriptionConfig = {
  // Default provider (can be: gladia, assemblyai, deepgram, azure-stt, openai-whisper, speechmatics)
  defaultProvider: process.env.TRANSCRIPTION_PROVIDER || "gladia",
};

// API URLs
export const apiUrls = {
  meetingBaas:
    process.env.MEETING_BAAS_API_URL || "https://api.meetingbaas.com",
  meetingBaasWebhook: process.env.MEETING_BAAS_WEBHOOK_URL || undefined,
};

if (!apiKeys.meetingBaas) {
  console.error("MEETING_BAAS_API_KEY is required");
  process.exit(1);
}

// Validate at least one transcription provider is configured
const hasTranscriptionProvider =
  apiKeys.gladia ||
  apiKeys.assemblyai ||
  apiKeys.deepgram ||
  apiKeys.azureStt ||
  apiKeys.openaiWhisper ||
  apiKeys.speechmatics;

if (!hasTranscriptionProvider) {
  console.error(
    "At least one transcription provider API key is required. Set one of: GLADIA_API_KEY, ASSEMBLYAI_API_KEY, DEEPGRAM_API_KEY, AZURE_STT_API_KEY, OPENAI_API_KEY, SPEECHMATICS_API_KEY"
  );
  process.exit(1);
}
