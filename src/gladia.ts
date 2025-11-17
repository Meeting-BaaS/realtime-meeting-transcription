import axios from "axios";
import WebSocket from "ws";
import { apiKeys } from "./config";
import { createLogger } from "./utils";

const logger = createLogger("Gladia");

// Gladia API client for real-time transcription
class GladiaClient {
  private apiKey: string;
  private apiUrl: string = "https://api.gladia.io";
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private onTranscriptionCallback:
    | ((text: string, isFinal: boolean) => void)
    | null = null;

  constructor() {
    this.apiKey = apiKeys.gladia || "";
    if (!this.apiKey) {
      logger.error(
        "Gladia API key not found. Please set GLADIA_API_KEY in .env"
      );
    }
  }

  // Initialize a streaming session with Gladia
  async initSession(): Promise<boolean> {
    try {
      const response = await axios.post(
        `${this.apiUrl}/v2/live`,
        {
          encoding: "wav/pcm",
          bit_depth: 16,
          sample_rate: 16000,
          channels: 1,
          model: "accurate",
          language_config: {
            languages: ["en"], // Set to English by default
            code_switching: false,
          },
          messages_config: {
            receive_partial_transcripts: true,
            receive_final_transcripts: true,
          },
        },
        {
          headers: {
            "x-gladia-key": this.apiKey,
          },
        }
      );

      this.sessionId = response.data.id;
      const wsUrl = response.data.url;

      logger.info(`Gladia session initialized: ${this.sessionId}`);

      // Connect to the WebSocket and wait for it to be ready
      await this.connectWebSocket(wsUrl);
      return true;
    } catch (error: any) {
      logger.error("Failed to initialize Gladia session:", error.message);
      if (error.response?.data) {
        logger.error("Gladia API error details:", JSON.stringify(error.response.data, null, 2));
      }
      return false;
    }
  }

  // Connect to Gladia's WebSocket for real-time transcription
  private connectWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        logger.info("Connected to Gladia WebSocket");
        resolve();
      });

    this.ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "transcript") {
          const utterance = message.data.utterance;
          const isFinal = message.data.is_final;

          if (utterance && utterance.text) {
            // only log if it's final, remove this
            // if you want to log partial transcripts
            if (isFinal) {
              logger.info(
                `Transcription ${isFinal ? "(final)" : "(partial)"}: ${
                  utterance.text
                }`
              );
            }

            if (this.onTranscriptionCallback) {
              this.onTranscriptionCallback(utterance.text, isFinal);
            }
          }
        }
      } catch (error) {
        logger.error("Error parsing Gladia message:", error);
      }
    });

    this.ws.on("error", (error) => {
      logger.error("Gladia WebSocket error:", error);
      reject(error);
    });

    this.ws.on("close", () => {
      logger.info("Gladia WebSocket connection closed");
    });
    });
  }

  // Send audio chunk to Gladia for transcription
  sendAudioChunk(audioData: Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn("WebSocket not connected, ignoring audio chunk");
      return false;
    }

    try {
      // Send audio chunk message
      const message = {
        type: "audio_chunk",
        data: {
          chunk: audioData.toString("base64"),
        },
      };

      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      logger.error("Error sending audio chunk to Gladia:", error);
      return false;
    }
  }

  // Set callback for transcription results
  onTranscription(callback: (text: string, isFinal: boolean) => void) {
    this.onTranscriptionCallback = callback;
  }

  // End transcription session
  endSession() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send stop recording message
      this.ws.send(JSON.stringify({ type: "stop_recording" }));
      this.ws.close();
    }
    this.ws = null;
    this.sessionId = null;
  }
}

export { GladiaClient };
