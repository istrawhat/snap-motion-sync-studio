# Changelog

## 2.4.1
- X/Twitter: videos now download with sound. X lists its MP4 files without codec details, and Snap used to skip them for video-only streams.
- Portrait videos (X, TikTok, Reels) are labelled by their short side, e.g. 1080p instead of 1920p.

## 2.4.0
- New lightning-bolt icon (toolbar, popup, Drive panel).
- Activity tab: compact cards, fits the popup without scrolling.
- Link tab stays within Chrome's 600 px popup height when conversion options are shown.

## 2.3.0
- Activity tab with live progress (download, join, convert, time left) and a toolbar % badge.
- H.265 conversion option (about 1.7× faster than H.264, smaller files).
- Converted files are sized from the original bitrate (no more 2–3× bigger files).
- YouTube downloads about 4× faster: un-throttled `&range=` requests and 8 connections.
- Waits for YouTube's `available_at` time, so new links aren't refused (HTTP 403).

## 2.2.0
- Video is always MP4 with AAC audio; WEBM is only shown under "All formats".
- Optional conversion to H.264 with the Mac's hardware encoder.

## 2.1.0
- Google Drive folders sent to Motrix keep their folder structure.

## 2.0.0
- Snap: MotrixGrab (social media → Motrix) and noZIP (Drive folders, no ZIP) merged into one extension.
- Popup with Link and Drive tabs; quality list with sizes and formats; right-click menu.
