#!/bin/bash
# Installs the Snap helper so Chrome can hand social-media links to Motrix.
# (Google Drive folder downloads work without this.)
set -e
cd "$(dirname "$0")"
DEST="$HOME/Library/Application Support/Snap by Motion Sync Studio"
EXT_ID="mhbmjoakklalifefkhfpamikchhhbbef"

if ! command -v yt-dlp >/dev/null && [ ! -x /opt/homebrew/bin/yt-dlp ] && [ ! -x /usr/local/bin/yt-dlp ]; then
  echo "Installing yt-dlp…"; brew install yt-dlp
fi
if ! command -v ffmpeg >/dev/null && [ ! -x /opt/homebrew/bin/ffmpeg ] && [ ! -x /usr/local/bin/ffmpeg ]; then
  echo "Installing ffmpeg…"; brew install ffmpeg
fi

mkdir -p "$DEST"
cp host/snap_host.py "$DEST/"
chmod +x "$DEST/snap_host.py"

MANIFEST='{
  "name": "com.motionsync.snap",
  "description": "Snap by Motion Sync Studio helper",
  "path": "'"$DEST"'/snap_host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://'"$EXT_ID"'/"]
}'

for browser in "Google/Chrome" "Google/Chrome Beta" "Chromium" "BraveSoftware/Brave-Browser" "Microsoft Edge" "Arc/User Data"; do
  dir="$HOME/Library/Application Support/$browser"
  if [ -d "$dir" ]; then
    mkdir -p "$dir/NativeMessagingHosts"
    echo "$MANIFEST" > "$dir/NativeMessagingHosts/com.motionsync.snap.json"
    echo "✓ Registered for $browser"
  fi
done

echo
echo "Done. In chrome://extensions: remove noZIP and MotrixGrab, then Load unpacked → this folder:"
echo "  $(pwd)"
