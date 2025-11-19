import dotenv from 'dotenv';

dotenv.config();

export const config = {
  meetingBaasApiKey: process.env.MEETING_BAAS_API_KEY || '',
  
  // OpenAI configuration
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  // The WebSocket endpoint for realtime transcription, per the latest OpenAI docs.
  openaiEndpoint: process.env.OPENAI_ENDPOINT || 'wss://api.openai.com/v1/realtime/transcriptions',

  // Proxy and MeetingBaas configuration
  proxyHost: process.env.PROXY_HOST || '0.0.0.0',
  proxyPort: parseInt(process.env.PROXY_PORT || '3000', 10),
  meetingBaasApiUrl: process.env.MEETING_BAAS_API_URL || 'https://api.meetingbaas.com',

  // Optional transcription provider flag (set to 'openai' for this integration)
  transcriptionProvider: process.env.TRANSCRIPTION_PROVIDER || 'openai',
};
