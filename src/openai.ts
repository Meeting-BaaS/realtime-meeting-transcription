import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from './config';

// Define the configuration structure required by OpenAI's realtime API.
// Check the latest docs to ensure these fields (and any additional ones) are correct.
export interface TranscriptionConfig {
  encoding: string;      
  sample_rate: number;   
  language: string;     
  interim_results?: boolean; // stream interim (partial) results if supported
}

// Define the expected structure of transcription responses.
// Expand with additional fields if needed per the latest API docs.
export interface TranscriptionResult {
  text: string;
  // Add any other fields returned by OpenAI's realtime transcription service.
}

export class OpenAIClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private endpoint: string;
  private apiKey: string;
  private transcriptionConfig: TranscriptionConfig;

  constructor(transcriptionConfig: TranscriptionConfig, endpoint?: string, apiKey?: string) {
    super();
    this.endpoint = endpoint || config.openaiEndpoint;
    this.apiKey = apiKey || config.openaiApiKey;
    if (!this.apiKey) {
      throw new Error('OpenAI API key not provided in config');
    }
    this.transcriptionConfig = transcriptionConfig;
  }

  /**
   * Establish the realtime transcription WebSocket connection.
   */
  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.endpoint, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      this.ws.on('open', () => {
        // Send the initial "start" message containing configuration.
        const startMessage = {
          type: 'start',
          config: this.transcriptionConfig,
        };
        this.ws?.send(JSON.stringify(startMessage));
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const messageStr = data instanceof Buffer ? data.toString('utf8') : data.toString();
          const message: TranscriptionResult = JSON.parse(messageStr);
          // Emit transcription events for consumers of this module.
          this.emit('transcription', message);
        } catch (error) {
          this.emit('error', new Error('Failed to parse message from OpenAI: ' + error));
        }
      });

      this.ws.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this.emit('close', { code, reason });
      });
    });
  }

  /**
   * Send a binary audio chunk to the realtime transcription service.
   * @param audioBuffer The audio data as a Buffer.
   */
  public sendAudio(audioBuffer: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Audio frames are sent as binary data.
      this.ws.send(audioBuffer);
    } else {
      this.emit('error', new Error('WebSocket is not open. Unable to send audio data.'));
    }
  }

  /**
   * Gracefully close the transcription WebSocket connection.
   */
  public close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // If required by the API, send a "stop" message.
      const stopMessage = { type: 'stop' };
      this.ws.send(JSON.stringify(stopMessage));
      this.ws.close();
    }
  }
}
