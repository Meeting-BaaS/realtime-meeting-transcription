<p align="center"><a href="https://discord.com/invite/dsvFgDTr6c"><img height="60px" src="https://user-images.githubusercontent.com/31022056/158916278-4504b838-7ecb-4ab9-a900-7dc002aade78.png" alt="Join our Discord!"></a></p>

# Real-Time Meeting Transcription

A Node.js application that connects to video meetings (Zoom, Google Meet, Microsoft Teams) and provides real-time audio transcription using MeetingBaas and Gladia APIs.

## Features

- Joins video conferences as a bot participant
- Streams audio from meetings to Gladia for real-time transcription
- Logs transcriptions with speaker detection
- Optional audio recording: Save meeting audio to WAV files
- Provides clean shutdown with proper resource cleanup
- Supports multiple video conferencing platforms through MeetingBaas

## Prerequisites

- Node.js (v16 or later)
- pnpm (or npm/yarn)
- MeetingBaas API key
- Gladia API key
- Ngrok or similar tool for exposing local webhook endpoints

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/yourusername/real-time-meeting-transcription.git
   cd real-time-meeting-transcription
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Create a `.env` file in the root directory (or copy from `.env.example`):
   ```
   MEETING_BAAS_API_KEY=your_meetingbaas_api_key
   GLADIA_API_KEY=your_gladia_api_key
   PROXY_HOST=0.0.0.0
   PROXY_PORT=3000

   # Optional: Enable audio recording
   ENABLE_AUDIO_RECORDING=false
   AUDIO_OUTPUT_DIR=./recordings

   # Optional: Enable audio playback through speakers
   ENABLE_AUDIO_PLAYBACK=false

   # Optional: Choose MeetingBaas environment
   # Production (default): https://api.meetingbaas.com
   # Pre-production: https://api.pre-prod-meetingbaas.com
   MEETING_BAAS_API_URL=https://api.meetingbaas.com
   ```

## Usage

1. Start ngrok to create a public URL for your webhook:

   ```bash
   ngrok http 3000
   ```

   Note the https URL that ngrok provides (e.g., https://abcd-123-456-789.ngrok-free.app).

2. Run the application:

   ```bash
   pnpm run dev <meeting_url> <bot_name> <ngrok_url>
   ```

   Example:

   ```bash
   pnpm run dev https://us06web.zoom.us/j/12345?pwd=abcdef "Transcription Bot" https://abcd-123-456-789.ngrok-free.app
   ```

3. The bot will join the meeting and begin transcribing audio in real-time.

4. To stop the transcription service, press `Ctrl+C` in your terminal. The application will gracefully shutdown.

## Architecture

The project consists of three main components:

1. **MeetingBaas Client** (`src/meetingbaas.ts`): Handles communication with the MeetingBaas API, which provides the bot service that joins meetings and streams audio.

2. **Proxy Server** (`src/proxy.ts`): A WebSocket server that acts as a bridge between MeetingBaas and Gladia. It receives audio from MeetingBaas and forwards it to Gladia, then captures transcriptions from Gladia.

3. **Gladia Client** (`src/gladia.ts`): Manages the connection to Gladia's real-time transcription API.

Data flow:

1. MeetingBaas bot joins a meeting via API
2. Audio from the meeting is sent to your webhook URL (ngrok)
3. The proxy server receives this audio and forwards it to Gladia
4. Gladia transcribes the audio and returns the transcription
5. The transcription is logged and can be processed further as needed

## Troubleshooting

- **401 Unauthorized Error**: Verify your MeetingBaas API key is correct in the `.env` file.
- **WebSocket Connection Issues**: Make sure your ngrok URL is correct and the proxy server is running.
- **No Audio Transcription**: Check that Gladia API key is valid and the WebSocket connection is established.
- **Bot Not Joining Meeting**: Ensure the meeting URL is valid and accessible without additional authentication.

## Configuration

The application can be configured via the `src/config.ts` file or environment variables:

- `MEETING_BAAS_API_KEY`: Your MeetingBaas API key
- `GLADIA_API_KEY`: Your Gladia API key
- `PROXY_HOST`: Host for the proxy server (default: 0.0.0.0)
- `PROXY_PORT`: Port for the proxy server (default: 3000)
- `MEETING_BAAS_API_URL`: MeetingBaas API URL (default: https://api.meetingbaas.com)
- `ENABLE_AUDIO_RECORDING`: Enable audio recording (default: false)
- `AUDIO_OUTPUT_DIR`: Directory where audio recordings will be saved (default: ./recordings)
- `ENABLE_AUDIO_PLAYBACK`: Enable real-time audio playback through computer speakers (default: false)

### Environment Selection

To switch between MeetingBaas environments, update the `MEETING_BAAS_API_URL` in your `.env` file:

**Production (default):**
```
MEETING_BAAS_API_URL=https://api.meetingbaas.com
```

**Pre-production:**
```
MEETING_BAAS_API_URL=https://api.pre-prod-meetingbaas.com
```

### Audio Recording

The application can optionally save the meeting audio to WAV files. To enable this feature:

1. Set `ENABLE_AUDIO_RECORDING=true` in your `.env` file
2. (Optional) Configure the output directory with `AUDIO_OUTPUT_DIR=./recordings`

When enabled, the application will:
- Capture all audio received from MeetingBaas
- Concatenate the audio chunks into a single buffer
- Save the audio as a WAV file when the meeting ends or the bot disconnects
- Generate timestamped filenames (e.g., `recording_2025-11-26T12-30-45-123Z.wav`)

The recorded audio will have the following specifications:
- Format: WAV (PCM)
- Sample Rate: 16kHz
- Channels: Mono (1 channel)
- Bit Depth: 16-bit

**Note:** Recording is disabled by default. Audio files can be large, so make sure you have sufficient disk space.

### Audio Playback

The application can play meeting audio in real-time through your computer speakers. To enable this feature:

1. Set `ENABLE_AUDIO_PLAYBACK=true` in your `.env` file
2. Make sure your system has audio output devices configured

When enabled, the application will:
- Stream audio from the meeting directly to your computer speakers in real-time
- Buffer audio chunks automatically to handle network delays
- Maintain audio quality at 16kHz mono, 16-bit PCM format

**Important notes:**
- Audio playback is disabled by default
- The speaker may take a moment to initialize when the first audio arrives
- Audio is buffered briefly to prevent gaps during initialization
- You'll hear the meeting audio with minimal latency (typically < 500ms)
- Playback will stop automatically when the meeting ends or the bot disconnects

**Troubleshooting:**
- If you don't hear audio, check your system's audio output settings
- On macOS/Linux, you may need to grant Node.js permission to access audio output
- If audio is choppy, check your network connection quality

## License

MIT
