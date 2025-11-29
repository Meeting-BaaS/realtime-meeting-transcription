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

// API keys
export const apiKeys = {
  meetingBaas: process.env.MEETING_BAAS_API_KEY || "",
  gladia: process.env.GLADIA_API_KEY || "",
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

if (!apiKeys.gladia) {
  console.error("GLADIA_API_KEY is required");
  process.exit(1);
}
