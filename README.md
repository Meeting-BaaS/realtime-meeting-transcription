<p align="center"><a href="https://discord.com/invite/dsvFgDTr6c"><img height="60px" src="https://user-images.githubusercontent.com/31022056/158916278-4504b838-7ecb-4ab9-a900-7dc002aade78.png" alt="Join our Discord!"></a></p>

# Real-Time Meeting Transcription

A Node.js application that connects to video meetings (Zoom, Google Meet, Microsoft Teams) and provides real-time audio transcription with a beautiful TUI dashboard. Supports multiple transcription providers through the VoiceRouter SDK.

## Features

- **Multi-Provider Transcription**: Gladia, Deepgram, AssemblyAI (easily switchable)
- **Real-Time TUI Dashboard**: Live transcription display with audio visualization
- **Two Operating Modes**:
  - **Remote Mode**: Bot joins meetings via MeetingBaas API
  - **Local Mode**: Accept audio from any WebSocket source
- **Automatic Transcript Logging**: Sessions saved to organized folders with JSON, TXT, and raw logs
- **Built-in Webhook Server**: Receive MeetingBaas events directly
- **Audio Recording**: Optionally save meeting audio to WAV files
- **Audio Playback**: Listen to meeting audio through your speakers
- **Graceful Shutdown**: Data storage summary on exit

## Prerequisites

- Node.js (v18 or later)
- pnpm (or npm/yarn)
- MeetingBaas API key
- At least one transcription provider API key (Gladia, Deepgram, or AssemblyAI)
- Ngrok or similar tool for exposing local endpoints (for remote mode)

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/Meeting-Baas/realtime-meeting-transcription.git
   cd realtime-meeting-transcription
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Create a `.env` file:

   ```bash
   # Required
   MEETING_BAAS_API_KEY=your_meetingbaas_api_key

   # At least one transcription provider (Gladia is default)
   GLADIA_API_KEY=your_gladia_api_key
   # DEEPGRAM_API_KEY=your_deepgram_api_key
   # ASSEMBLYAI_API_KEY=your_assemblyai_api_key

   # Optional: Choose provider (default: gladia)
   TRANSCRIPTION_PROVIDER=gladia

   # Optional: Server config
   PROXY_HOST=0.0.0.0
   PROXY_PORT=4040

   # Optional: Features
   ENABLE_TRANSCRIPT_LOGGING=true
   ENABLE_AUDIO_RECORDING=false
   ENABLE_AUDIO_PLAYBACK=false
   ```

## Usage

### Remote Mode (MeetingBaas Bot)

The bot joins a meeting via MeetingBaas API and streams audio to your local proxy:

1. Start ngrok to expose your local server:

   ```bash
   ngrok http 4040
   ```

2. Run the application:

   ```bash
   # Basic usage (webhook URL auto-derived from streaming URL)
   pnpm run remote <meeting_url> [bot_name] <ngrok_wss_url>

   # Example
   pnpm run remote "https://meet.google.com/abc-defg-hij" "My Bot" "wss://abcd.ngrok-free.app"
   ```

   The webhook URL is automatically derived: `wss://...` → `https://.../webhooks/meetingbaas`

3. The TUI dashboard will display:
   - Live transcriptions with timestamps
   - Audio visualization
   - System logs
   - Configuration status

4. Press `Ctrl+C` to stop. You'll see a data storage summary showing where transcripts and logs were saved.

### Local Mode (Proxy Only)

Accept audio from any WebSocket source (Docker bots, custom clients):

```bash
pnpm run dev:local
```

The proxy listens on `ws://localhost:4040` for incoming audio streams.

## TUI Dashboard

The application features a real-time terminal UI showing:

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                    🎙️ Real-Time Meeting Transcription                        ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║ Mode: Remote | Provider: gladia | Port: 4040 | Uptime: 2:45                   ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║ Speaker: John Smith                                                           ║
╠═════════════════════════════════════════════════════════════════════════[▁▃▅]═╣
║                                                                               ║
║ 💬 Live Transcription                    │ 📋 Logs                            ║
║ ─────────────────────────────────────────│────────────────────────────────────║
║ [2:43] Hello everyone, let's get started │ ℹ️ Bot joined meeting              ║
║ [2:44] Thanks for joining today          │ ℹ️ Transcription active            ║
║ [2:45] First topic is the Q4 results     │ ℹ️ Speaker: John Smith             ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

## Data Storage

### Transcript Sessions

Automatically saved to `./transcripts/sessions/{timestamp}_{uuid}/`:

- `transcript.json` - Structured JSON with all data
- `transcript.txt` - Human-readable format
- `raw_logs.txt` - Real-time logs with interim transcripts
- `session_info.txt` - Session metadata

### Process Logs

Saved to `./logs/process-{timestamp}.log` with all system events.

### Audio Recordings

When enabled, saved to `./recordings/recording_{timestamp}.wav` (16-bit PCM, 16kHz, mono).

### Shutdown Summary

On exit, you'll see where all data was stored:

```
╔═══════════════════════════════════════════════════════════════════╗
║                    📁 DATA STORAGE SUMMARY                        ║
╚═══════════════════════════════════════════════════════════════════╝

📝 Process Logs:
   ./logs/process-2025-12-19T10-30-45.log

💬 Transcription Session:
   ./transcripts/sessions/20251219_103045_a1b2c3d4/
   • Duration: 125.45s
   • Transcripts: 42

🎤 Audio Recording:
   ./recordings/recording_2025-12-19T10-30-45.wav
   • Size: 24.56 MB
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEETING_BAAS_API_KEY` | - | MeetingBaas API key (required) |
| `GLADIA_API_KEY` | - | Gladia transcription API key |
| `DEEPGRAM_API_KEY` | - | Deepgram transcription API key |
| `ASSEMBLYAI_API_KEY` | - | AssemblyAI transcription API key |
| `TRANSCRIPTION_PROVIDER` | `gladia` | Default provider: `gladia`, `deepgram`, `assemblyai` |
| `PROXY_HOST` | `0.0.0.0` | Server host |
| `PROXY_PORT` | `4040` | Server port |
| `ENABLE_TRANSCRIPT_LOGGING` | `true` | Save transcripts to files |
| `TRANSCRIPT_OUTPUT_DIR` | `./transcripts` | Transcript output directory |
| `ENABLE_AUDIO_RECORDING` | `false` | Save audio to WAV files |
| `AUDIO_OUTPUT_DIR` | `./recordings` | Audio output directory |
| `ENABLE_AUDIO_PLAYBACK` | `false` | Play audio through speakers |
| `MEETING_BAAS_API_URL` | `https://api.meetingbaas.com` | MeetingBaas API URL |

### Switching Transcription Providers

```bash
# Use Deepgram
TRANSCRIPTION_PROVIDER=deepgram pnpm run remote ...

# Use AssemblyAI
TRANSCRIPTION_PROVIDER=assemblyai pnpm run remote ...
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  MeetingBaas    │────▶│  Proxy Server    │────▶│  VoiceRouter SDK    │
│  (Bot in call)  │     │  (WebSocket +    │     │  (Gladia/Deepgram/  │
│                 │◀────│   HTTP Webhooks) │◀────│   AssemblyAI)       │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │  TUI Dashboard   │
                        │  + Transcript    │
                        │    Logger        │
                        └──────────────────┘
```

**Components:**

1. **MeetingBaas Client** (`src/meetingbaas.ts`): Manages bot lifecycle via MeetingBaas API
2. **Proxy Server** (`src/proxy.ts`): WebSocket + Express server handling audio streaming and webhooks
3. **Transcription Client** (`src/gladia.ts`): VoiceRouter SDK wrapper supporting multiple providers
4. **TUI Visualizer** (`src/audioVisualizer.ts`): Real-time terminal dashboard
5. **Transcript Logger** (`src/transcriptLogger.ts`): Session-based transcript storage

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **401 Unauthorized** | Check your MeetingBaas API key in `.env` |
| **No transcription** | Verify transcription provider API key is valid |
| **WebSocket errors** | Ensure ngrok URL is correct and uses `wss://` |
| **Bot not joining** | Check meeting URL is valid and accessible |
| **TUI not displaying** | Ensure terminal supports ANSI escape codes |

## Scripts

```bash
pnpm run dev:local      # Local mode (proxy only)
pnpm run remote         # Remote mode (MeetingBaas bot)
pnpm run build          # Build TypeScript
```

## Documentation

- [Transcript Logging](./TRANSCRIPT_LOGGING.md) - Detailed transcript feature documentation
- [Data Storage](./DATA_STORAGE.md) - Where and how data is stored

## License

MIT
