# Audio Playback Troubleshooting Guide

## The Problem

The `speaker` npm package is a native Node.js addon that requires compilation for your specific system. When installed via pnpm, the build scripts are blocked by default for security reasons, resulting in missing native bindings.

**Error you'll see:**
```
[Proxy] [ERROR] Failed to load speaker module. Audio playback will be disabled.
Error: Could not locate the bindings file.
```

## The Fix

The `speaker` package needs its native bindings compiled. Run this command from your project root:

```bash
cd node_modules/.pnpm/speaker@0.5.5/node_modules/speaker && npx node-gyp rebuild
```

Or if the path changes, find it first:

```bash
# Find the speaker package
find node_modules -type d -name "speaker" | grep -v node_modules/speaker/node_modules | head -1

# Then cd into it and rebuild
cd <path-from-above> && npx node-gyp rebuild
```

## Verification

After rebuilding, you should see:

1. The native binding file exists:
```bash
ls -la node_modules/.pnpm/speaker@0.5.5/node_modules/speaker/build/Release/binding.node
```

2. When you run the app, you'll see these success messages:
```
[Proxy] [INFO] Speaker module loaded successfully
[Proxy] [INFO] Speaker initialized for audio playback
[Proxy] [INFO] Audio playback started
```

## Requirements

Before rebuilding, ensure you have:
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `build-essential` package
- **Windows**: Visual Studio Build Tools

Check if tools are installed:
```bash
xcode-select -p  # macOS
```

## For Future Installs

The `.npmrc` file has been updated with:
```
enable-pre-post-scripts=true
ignore-scripts=false
approved-builds=["speaker"]
```

However, pnpm may still require manual rebuilding after `pnpm install`.

## Quick Fix Script

Save this as `fix-speaker.sh`:

```bash
#!/bin/bash
SPEAKER_PATH=$(find node_modules -type d -name "speaker" | grep -v node_modules/speaker/node_modules | head -1)
if [ -z "$SPEAKER_PATH" ]; then
  echo "Speaker package not found. Run 'pnpm install' first."
  exit 1
fi
cd "$SPEAKER_PATH" && npx node-gyp rebuild
echo "Speaker bindings rebuilt successfully!"
```

Make it executable and run:
```bash
chmod +x fix-speaker.sh
./fix-speaker.sh
```
