#!/usr/bin/env python3
"""Native messaging helper for Snap.

Chrome sends {url, mode, cookies}. We use yt-dlp to turn a page link
(YouTube, Facebook, Instagram, ...) into the real file URL, then hand it
to Motrix over its aria2 RPC. Links yt-dlp doesn't know go to Motrix as-is.
"""
import json
import os
import re
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

os.environ["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", "")
MOTRIX_SETTINGS = Path.home() / "Library/Application Support/Motrix/settings.json"
LOG = Path.home() / "Library/Logs/Snap.log"

HTTP = "[protocol^=http][protocol!*=dash]"
FORMATS = {
    # Highest resolution: separate video + audio, both fetched by Motrix, merged afterwards.
    "best": "bv*{0}+ba[ext=m4a]{0}/bv*{0}+ba{0}/b{0}/bv*+ba/b".format(HTTP),
    # One file with audio+video over plain HTTP, so Motrix can download it.
    "video": "b[protocol^=http][protocol!*=dash][vcodec!=none][acodec!=none]/b[protocol^=http][protocol!*=dash]/b",
    "audio": "ba[ext=m4a][protocol^=http][protocol!*=dash]/ba[protocol^=http][protocol!*=dash]/ba/b",
}


def log(*args):
    with LOG.open("a") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + " ".join(str(a) for a in args) + "\n")


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        sys.exit(0)
    size = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(size).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def motrix_config():
    try:
        engine = json.loads(MOTRIX_SETTINGS.read_text()).get("engine", {})
        app = json.loads(MOTRIX_SETTINGS.read_text()).get("app", {})
        return int(engine.get("rpcPort", 16800)), engine.get("rpcSecret", ""), app.get("defaultSaveDir")
    except Exception:
        return 16800, "", None


def rpc(method, params):
    port, secret, _ = motrix_config()
    body = json.dumps({"jsonrpc": "2.0", "id": "mg", "method": method,
                       "params": (["token:" + secret] if secret else []) + params}).encode()
    req = urllib.request.Request("http://127.0.0.1:%d/jsonrpc" % port, body,
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        res = json.loads(r.read())
    if "error" in res:
        raise RuntimeError("Motrix: " + res["error"].get("message", "error"))
    return res["result"]


def ensure_motrix():
    try:
        rpc("aria2.getVersion", [])
        return
    except RuntimeError:
        raise
    except Exception:
        pass
    subprocess.Popen(["open", "-g", "-a", "Motrix"])
    for _ in range(30):
        time.sleep(0.5)
        try:
            rpc("aria2.getVersion", [])
            return
        except RuntimeError:
            raise
        except Exception:
            pass
    raise RuntimeError("Couldn't reach Motrix. Is it installed and running?")


def safe_name(name):
    name = re.sub(r'[\\/:*?"<>|\n\r\t]+', " ", name or "download").strip()
    return name[:150] or "download"


def wait_available(*fs):
    """YouTube links only work from their "available_at" time (a few seconds after extraction)."""
    delay = max((f.get("available_at") or 0) for f in fs) - time.time() + 1
    if 0 < delay < 60:
        time.sleep(delay)


def youtube_fast_url(url, size):
    """googlevideo throttles plain requests to about playback speed; asking for an explicit
    &range= gets full speed (it's how YouTube's own player and yt-dlp fetch)."""
    if size and "googlevideo.com" in url and "range=" not in url:
        return url + "&range=0-%d" % (int(size) - 1)
    return url


def add_to_motrix(url, out=None, headers=None, media=False, size=0):
    # 8 connections: fast, without tripping YouTube's limits (16 got refused).
    opts = {"split": "8", "max-connection-per-server": "8", "min-split-size": "4M",
            "max-tries": "10", "retry-wait": "3"} if media else {}
    url = youtube_fast_url(url, size)
    if out:
        opts["out"] = out
    if headers:
        opts["header"] = ["%s: %s" % kv for kv in headers.items()]
    return rpc("aria2.addUri", [[url], opts])


def ytdlp_base(cookies):
    cmd = ["yt-dlp", "--no-playlist", "--no-warnings"]
    if cookies:
        cmd += ["--cookies-from-browser", "chrome"]
    return cmd


def download_with_ytdlp(url, cookies, fmt="bv*+ba/b"):
    """For streams Motrix can't handle (HD video+audio, HLS): yt-dlp downloads and merges."""
    _, _, save_dir = motrix_config()
    save_dir = save_dir if save_dir and os.path.isdir(save_dir) else str(Path.home() / "Downloads")
    cmd = ytdlp_base(cookies) + ["-f", fmt, "--merge-output-format", "mp4",
                                 "-o", os.path.join(save_dir, "%(title).150B.%(ext)s"), url]
    notify = "osascript -e 'display notification \"Finished\" with title \"Snap\"'"
    fail = "osascript -e 'display notification \"yt-dlp failed, see ~/Library/Logs/Snap.log\" with title \"Snap\"'"
    shell = " ".join(_q(c) for c in cmd) + " >>%s 2>&1 && %s || %s" % (_q(str(LOG)), notify, fail)
    subprocess.Popen(["/bin/sh", "-c", shell], start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return "Downloading with yt-dlp into %s — you'll get a notification when done." % save_dir


def is_http(f):
    proto = str(f.get("protocol", "https"))
    return bool(f.get("url")) and proto.startswith("http") and "dash" not in proto


def notify(text):
    subprocess.run(["osascript", "-e", 'display notification "%s" with title "Snap"' % text.replace('"', "'")])


JOBS = Path(__file__).resolve().parent / "jobs"
# H.264 needs more bits than AV1/VP9 for the same picture; H.265 about the same.
BITRATE_FACTOR = {"h264": 1.5, "hevc": 1.1}
ENCODER = {"h264": ["-c:v", "h264_videotoolbox", "-profile:v", "high", "-tag:v", "avc1"],
           "hevc": ["-c:v", "hevc_videotoolbox", "-tag:v", "hvc1"]}


def write_job(job, **fields):
    """Progress record the popup reads (one small JSON file per download)."""
    job.update(fields, updated=time.time())
    JOBS.mkdir(exist_ok=True)
    tmp = JOBS / (job["id"] + ".tmp")
    tmp.write_text(json.dumps(job))
    tmp.replace(JOBS / (job["id"] + ".json"))


def new_job(title, convert, total):
    job = {"id": "%d-%d" % (time.time() * 1000, os.getpid()), "title": title, "convert": convert or "",
           "stage": "downloading", "percent": 0, "total": total, "speed": 0, "eta": None, "created": time.time()}
    write_job(job)
    return job


def media_duration(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    try:
        return float(p.stdout.strip())
    except ValueError:
        return 0.0


def wait_for_downloads(job, parts):
    """Follow the Motrix downloads until every part is complete. Returns the file paths, or None."""
    gids, paths, sizes = parts[::3], parts[1::3], [int(x) for x in parts[2::3]]
    done = {}
    while len(done) < len(gids):
        got, total, speed = 0, 0, 0
        for gid, path, size in zip(gids, paths, sizes):
            if gid in done:
                got += done[gid]; total += done[gid]
                continue
            try:
                st = rpc("aria2.tellStatus", [gid, ["status", "completedLength", "totalLength", "downloadSpeed"]])
            except Exception:
                st = {"status": "gone"}
            status = st["status"]
            if status in ("error", "removed"):
                log("job: download", gid, status)
                write_job(job, stage="failed", error="A download failed or was removed in Motrix.")
                notify("Download failed in Motrix")
                return None
            if status in ("complete", "gone"):
                finished = os.path.exists(path) and not os.path.exists(path + ".aria2")
                if finished and size and os.path.getsize(path) != size:
                    finished = False  # Motrix gave up partway (it drops the .aria2 file then too)
                if finished:
                    done[gid] = os.path.getsize(path)
                    got += done[gid]; total += done[gid]
                    continue
                if status == "gone":
                    log("job: download vanished", gid, path)
                    write_job(job, stage="failed", error="A download disappeared from Motrix.")
                    return None
            got += int(st.get("completedLength") or 0)
            total += int(st.get("totalLength") or 0) or size
            speed += int(st.get("downloadSpeed") or 0)
        total = max(total, job.get("total") or 0)
        eta = (total - got) / speed if speed and total > got else None
        write_job(job, stage="downloading", percent=round(100 * got / total, 1) if total else 0,
                  done_bytes=got, total=total, speed=speed, eta=eta)
        if len(done) < len(gids):
            time.sleep(1)
    return paths


def run_ffmpeg(job, cmd, duration, stage):
    """Run ffmpeg and report its progress. Returns True on success."""
    cmd = cmd[:1] + ["-progress", "pipe:1", "-nostats"] + cmd[1:]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    last = 0
    for line in p.stdout:
        key, _, value = line.strip().partition("=")
        if key == "out_time_us" and value.isdigit() and duration:
            pos = int(value) / 1e6
            if time.time() - last > 0.7:
                elapsed = time.time() - job["stage_started"]
                rate = pos / elapsed if elapsed > 1 else 0
                eta = (duration - pos) / rate if rate else None
                write_job(job, stage=stage, percent=round(min(99.9, 100 * pos / duration), 1),
                          speed=round(rate, 2), eta=eta)
                last = time.time()
    p.wait()
    if p.returncode != 0:
        log("job: ffmpeg failed", p.stderr.read()[-500:])
    return p.returncode == 0


def merge_when_done(job_id, output, convert, parts):
    """Runs detached: follow the Motrix downloads, then join (and maybe convert) with ffmpeg."""
    job = json.loads((JOBS / (job_id + ".json")).read_text())
    paths = wait_for_downloads(job, parts)
    if not paths:
        return
    if len(paths) == 1 and not convert:
        write_job(job, stage="done", percent=100, output=paths[0], size=os.path.getsize(paths[0]), eta=None)
        return notify("Done: " + os.path.basename(paths[0]))

    base, ext = os.path.splitext(output)
    n = 1
    while os.path.exists(output):
        output = "%s (%d)%s" % (base, n, ext)
        n += 1
    duration = media_duration(paths[0])
    cmd = ["ffmpeg", "-loglevel", "error", "-n"]
    if convert:
        cmd += ["-hwaccel", "videotoolbox"]
    for path in paths:
        cmd += ["-i", path]
    cmd += ["-map", "0:v:0"] + (["-map", "1:a:0"] if len(paths) > 1 else ["-map", "0:a?"])
    if convert:
        video_bytes = os.path.getsize(paths[0])
        kbps = int(video_bytes * 8 / max(duration, 1) / 1000 * BITRATE_FACTOR[convert])
        cmd += ENCODER[convert] + ["-b:v", "%dk" % max(kbps, 2000), "-c:a", "copy"]
        stage = "converting"
    else:
        cmd += ["-c", "copy"]
        if codec_name(probe_codec(paths[0])) == "H.265":
            cmd += ["-tag:v", "hvc1"]  # lets QuickTime open HEVC in MP4
        stage = "joining"
    cmd += ["-movflags", "+faststart", output]
    write_job(job, stage=stage, percent=0, speed=0, eta=None, stage_started=time.time())
    if not run_ffmpeg(job, cmd, duration, stage):
        write_job(job, stage="failed", error="Joining failed. The separate video and audio files are kept.")
        return notify("Joining failed, the separate video and audio files are kept")
    for path in paths:
        os.remove(path)
    log("merged", output)
    write_job(job, stage="done", percent=100, output=output, size=os.path.getsize(output), eta=None)
    notify("Done: " + os.path.basename(output))


def start_job(title, parts, output, convert, total):
    job = new_job(title, convert, total)
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "--merge", job["id"], output, convert or ""] + parts,
                     start_new_session=True, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def list_jobs():
    jobs = []
    for f in JOBS.glob("*.json") if JOBS.exists() else []:
        try:
            job = json.loads(f.read_text())
        except Exception:
            continue
        if time.time() - job.get("updated", 0) > 12 * 3600:
            f.unlink(missing_ok=True)
            continue
        jobs.append(job)
    jobs.sort(key=lambda j: j.get("created", 0), reverse=True)
    return {"ok": True, "jobs": jobs[:10]}


def clear_jobs():
    for f in JOBS.glob("*.json") if JOBS.exists() else []:
        try:
            if json.loads(f.read_text()).get("stage") in ("done", "failed"):
                f.unlink()
        except Exception:
            pass
    return list_jobs()


def send_single(title, f, convert=""):
    headers = dict(f.get("http_headers") or {})
    if f.get("cookies"):
        headers["Cookie"] = f["cookies"]
    name = safe_name(title)
    ext = f.get("ext") or "mp4"
    out = "%s [original, converts automatically].%s" % (name, ext) if convert else "%s.%s" % (name, ext)
    wait_available(f)
    gid = add_to_motrix(f["url"], out, headers, media=True, size=f.get("filesize"))
    path = os.path.join(rpc("aria2.getOption", [gid])["dir"], out)
    output = os.path.join(os.path.dirname(path), name + ".mp4") if convert else path
    start_job(title, [gid, path, str(f.get("filesize") or 0)], output, convert, f.get("filesize") or 0)


def probe_codec(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    return p.stdout.strip()


def send_merged(title, video, audio, convert=""):
    """Queue the video and audio streams in Motrix and start a background merger."""
    name = safe_name(title)
    parts = []
    wait_available(video, audio)
    for f, kind in ((video, "video"), (audio, "audio")):
        headers = dict(f.get("http_headers") or {})
        if f.get("cookies"):
            headers["Cookie"] = f["cookies"]
        out = "%s [%s, joins automatically].%s" % (name, kind, f.get("ext"))
        gid = add_to_motrix(f["url"], out, headers, media=True, size=f.get("filesize"))
        parts += [gid, os.path.join(rpc("aria2.getOption", [gid])["dir"], out), str(f.get("filesize") or 0)]
    container = "mp4" if convert else merged_ext(video, audio)
    output = os.path.join(os.path.dirname(parts[1]), name + "." + container)
    start_job(title, parts, output, convert, (video.get("filesize") or 0) + (audio.get("filesize") or 0))


def merged_ext(video, audio):
    # MP4 holds H.264, AV1, VP9 and H.265 alike; only non-AAC audio (Opus) needs MKV. Never WEBM.
    return "mp4" if audio.get("ext") in ("m4a", "mp4") else "mkv"


CODECS = (("avc", "H.264"), ("h264", "H.264"), ("av01", "AV1"), ("vp09", "VP9"), ("vp9", "VP9"),
          ("hev", "H.265"), ("hvc", "H.265"), ("h265", "H.265"), ("mp4a", "AAC"), ("opus", "Opus"))


def codec_name(c):
    c = (c or "").lower()
    for prefix, name in CODECS:
        if c.startswith(prefix):
            return name
    return c.split(".")[0].upper() or "?"


def has(f, kind):
    return f.get(kind) not in (None, "none")


def lacks(f, kind):
    """True only when the site says the stream has no such track. Unknown (None) is not "lacks":
    X/Twitter lists its normal MP4 files (video + sound) without naming any codec."""
    return f.get(kind) == "none"


def short_side(f):
    # Portrait videos (X, TikTok, Reels) are 1080x1920: call that 1080p, like the sites do.
    w, h = f.get("width"), f.get("height")
    return min(w, h) if w and h else (h or 0)


def part(f):
    """Just what's needed later to hand this stream to Motrix."""
    headers = dict(f.get("http_headers") or {})
    if f.get("cookies"):
        headers["Cookie"] = f["cookies"]
    return {"url": f.get("url"), "ext": f.get("ext"), "http_headers": headers, "filesize": f.get("filesize") or 0,
            "available_at": f.get("available_at"),
            "format_id": f.get("format_id"), "http": is_http(f)}


def size_of(*fs):
    exact = all(f.get("filesize") for f in fs)
    return sum(f.get("filesize") or f.get("filesize_approx") or 0 for f in fs), not exact


def probe_unknown(formats):
    """Some sites (Facebook "hd"/"sd") don't say what's in a file. A quick ffprobe of the URL
    reads its codec, resolution and size from the first few kilobytes."""
    from concurrent.futures import ThreadPoolExecutor

    def probe(f):
        headers = "".join("%s: %s\r\n" % kv for kv in (f.get("http_headers") or {}).items())
        try:
            p = subprocess.run(["ffprobe", "-v", "error", "-headers", headers, "-show_entries",
                                "stream=codec_type,codec_name,width,height:format=size", "-of", "json", f["url"]],
                               capture_output=True, text=True, timeout=15)
            data = json.loads(p.stdout or "{}")
        except Exception:
            return
        streams = data.get("streams") or []
        v = next((x for x in streams if x.get("codec_type") == "video"), None)
        a = next((x for x in streams if x.get("codec_type") == "audio"), None)
        if v:
            f.update(vcodec={"h264": "avc1", "hevc": "hvc1", "av1": "av01", "vp9": "vp09"}.get(v["codec_name"], v["codec_name"]),
                     width=v.get("width"), height=v.get("height"))
        f["acodec"] = ("mp4a" if a["codec_name"] == "aac" else a["codec_name"]) if a else "none"
        if (data.get("format") or {}).get("size") and not f.get("filesize"):
            f["filesize"] = int(data["format"]["size"])

    todo = [f for f in formats if is_http(f) and not has(f, "vcodec") and not lacks(f, "vcodec")
            and not f.get("height") and f.get("ext") in ("mp4", "mov", "webm", "mkv")][:6]
    if todo:
        with ThreadPoolExecutor(len(todo)) as pool:
            list(pool.map(probe, todo))


def build_choices(info):
    formats = [f for f in info.get("formats") or [info] if f.get("url")]
    probe_unknown(formats)
    duration = info.get("duration") or 0
    for f in formats:  # sites that give a bitrate but no size (Facebook's AV1): estimate it
        if not f.get("filesize") and not f.get("filesize_approx") and f.get("tbr") and duration:
            f["filesize_approx"] = int(f["tbr"] * 1000 / 8 * duration)
    audio_key = lambda f: (f.get("language_preference") or -1, f.get("abr") or f.get("tbr") or 0)
    audios = sorted((f for f in formats if lacks(f, "vcodec") and not lacks(f, "acodec")
                     and "drc" not in str(f.get("format_id"))), key=audio_key, reverse=True)

    def best_audio(ext):
        same = [a for a in audios if a.get("ext") == ext]
        return (same or audios or [None])[0]

    def is_video(f):
        if lacks(f, "vcodec") or f.get("vcodec") == "images" or f.get("ext") == "mhtml":
            return False
        return has(f, "vcodec") or bool(f.get("height") or f.get("width"))

    # Unnamed codecs: borrow the codec of a named stream with the same resolution.
    known = {short_side(f): codec_name(f["vcodec"]) for f in formats if is_video(f) and has(f, "vcodec")}

    def video_codec(f):
        if has(f, "vcodec"):
            return codec_name(f["vcodec"])
        return known.get(short_side(f)) or ("H.264" if f.get("ext") == "mp4" else (f.get("ext") or "?").upper())

    # One entry per resolution/fps/codec/HDR; prefer a file that already has sound, then plain HTTP, then bitrate.
    picked = {}
    for f in formats:
        if not is_video(f):
            continue
        key = (short_side(f), round(f.get("fps") or 0), video_codec(f), f.get("dynamic_range") or "SDR")
        rank = (not lacks(f, "acodec"), is_http(f), f.get("tbr") or 0)
        if key not in picked or rank > picked[key][0]:
            picked[key] = (rank, f)

    order = {"H.264": 0, "VP9": 1, "AV1": 2, "H.265": 3}
    choices = []
    for key in sorted(picked, key=lambda k: (-k[0], -k[1], order.get(k[2], 9))):
        f = picked[key][1]
        height, fps, codec, dr = key
        if not lacks(f, "acodec") or not audios:
            fs, ext = [f], f.get("ext")
        else:
            a = best_audio("m4a")
            fs, ext = [f, a], merged_ext(f, a)
        size, approx = size_of(*fs)
        label = ("%dp" % height if height else (f.get("format_note") or f.get("format_id") or "Video"))
        if fps > 30:
            label += str(fps)
        choices.append({"kind": "video", "label": label, "codec": codec, "ext": ext.upper(), "size": size,
                        "approx": approx, "hdr": dr not in ("SDR", None), "parts": [part(x) for x in fs],
                        "fmt": "+".join(x.get("format_id") or "" for x in fs)})

    audio_picks = [next((x for x in audios if x.get("ext") == ext), None) for ext in ("m4a", "webm")]
    if not any(audio_picks) and audios:
        audio_picks = [audios[0]]  # e.g. X: AAC audio as an HLS stream with ext "mp4"
    for a in audio_picks:
        if a:
            ext = "webm" if a.get("ext") == "webm" else "m4a"
            size, approx = size_of(a)
            abr = a.get("abr") or a.get("tbr")
            choices.append({"kind": "audio", "label": "Audio" + (" %dk" % abr if abr else ""),
                            "codec": codec_name(a.get("acodec")) if has(a, "acodec") else ("Opus" if ext == "webm" else "AAC"),
                            "ext": "M4A" if ext == "m4a" else "WEBM",
                            "size": size, "approx": approx, "hdr": False, "parts": [part(a)], "fmt": a.get("format_id")})
    # Streams only yt-dlp can fetch are worth listing only when nothing else offers that resolution.
    http_labels = {c["label"] for c in choices if all(p["http"] for p in c["parts"])}
    choices = [c for c in choices if c["label"] not in http_labels or all(p["http"] for p in c["parts"])]
    return choices[:30]


def run_ytdlp_json(url, cookies, extra):
    """Returns (info, None) or (None, reply-dict for the popup)."""
    p = subprocess.run(ytdlp_base(cookies) + ["-J"] + extra + [url], capture_output=True, text=True, timeout=120)
    if p.returncode == 0:
        return json.loads(p.stdout), None
    err = p.stderr.strip().splitlines()[-1] if p.stderr.strip() else "yt-dlp failed"
    log("yt-dlp error", err)
    if "Unsupported URL" in err:
        return None, {"unsupported": True}
    err = re.sub(r"^ERROR: (\[\w+\] [\w-]+: )?", "", err).split(". ")[0]
    if re.search(r"login|logged|cookies|private|rate.limit|empty media", p.stderr, re.I) and not cookies:
        err += ".\n\nTip: tick “Use my Chrome login” and try again."
    return None, {"ok": False, "error": err}


def clean_title(info):
    title = (info.get("title") or "").strip()
    if info.get("extractor_key", "").lower().startswith("facebook"):
        title = re.sub(r"^[\d.,]+[KMB]? views?\s*·\s*[\d.,]+[KMB]? reactions?\s*\|\s*", "", title)
        uploader = info.get("uploader") or ""
        if uploader and title.endswith("| " + uploader):
            title = title[: -len(uploader) - 2].strip(" |")
        title = re.split(r"\s#\w", title)[0].strip()  # drop the hashtag tail
    if not title or title.lower() in ("video", "reel"):
        title = " ".join(x for x in (info.get("uploader"), info.get("id")) if x) or "Video"
    if len(title) > 80:
        title = title[:80].rsplit(" ", 1)[0] + "…"
    return title.rstrip(" .|·,")


def list_qualities(url, cookies):
    info, fail = run_ytdlp_json(url, cookies, [])
    if fail:
        return {"ok": True, "direct": True} if fail.get("unsupported") else fail
    if info.get("entries"):
        entries = [e for e in info["entries"] if e]
        return {"ok": True, "multi": len(entries), "title": info.get("title")}
    choices = build_choices(info)
    if not choices:
        return {"ok": True, "direct": True}
    return {"ok": True, "title": clean_title(info), "thumbnail": info.get("thumbnail"),
            "duration": info.get("duration"), "site": info.get("extractor_key"), "choices": choices}


def add_file(msg):
    """Queue one ready-to-download file (e.g. from Google Drive) in Motrix, inside a sub-folder."""
    ensure_motrix()
    base = rpc("aria2.getGlobalOption", [])["dir"]
    parts = [safe_name(p) for p in msg.get("subdir") or [] if p not in (".", "..")]
    opts = {"dir": os.path.join(base, *parts), "split": "8", "max-connection-per-server": "8",
            "max-tries": "10", "retry-wait": "3", "allow-overwrite": "true" if msg.get("overwrite") else "false"}
    if msg.get("out"):
        opts["out"] = safe_name(msg["out"])
    if msg.get("headers"):
        opts["header"] = ["%s: %s" % kv for kv in msg["headers"].items()]
    gid = rpc("aria2.addUri", [[msg["url"]], opts])
    log("added", opts["dir"], opts.get("out"))
    return {"ok": True, "gid": gid}


def grab_choice(url, cookies, title, choice, convert=""):
    parts = choice["parts"]
    if not all(p.get("http") for p in parts):
        return download_with_ytdlp(url, cookies, choice["fmt"])
    ensure_motrix()
    convert = convert if convert in ENCODER and choice.get("kind") == "video" and choice.get("codec") not in ("H.264", "H.265") else ""
    if len(parts) == 1:
        send_single(title, parts[0], convert)
    else:
        send_merged(title, parts[0], parts[1], convert)
    if convert:
        return "Sent to Motrix: %s, will be converted to %s MP4" % (choice["label"], "H.264" if convert == "h264" else "H.265")
    return "Sent to Motrix: %s %s %s" % (choice["label"], choice["codec"], choice["ext"])


def _q(s):
    return "'" + s.replace("'", "'\\''") + "'"


def handle(msg):
    url, mode, cookies = msg.get("url", "").strip(), msg.get("mode", "best"), bool(msg.get("cookies"))
    convert = msg.get("convert") if msg.get("convert") in ENCODER else ""
    log("request", msg.get("action", mode), url)
    if msg.get("action") == "list":
        return list_qualities(url, cookies)
    if msg.get("action") == "jobs":
        return list_jobs()
    if msg.get("action") == "clear_jobs":
        return clear_jobs()
    if msg.get("action") == "reveal":
        out = msg.get("path", "")
        if out and os.path.exists(out):
            subprocess.run(["open", "-R", out])
        return {"ok": True}
    if msg.get("action") == "add":
        return add_file(msg)
    if msg.get("action") == "choice":
        return {"ok": True, "message": grab_choice(url, cookies, msg.get("title"), msg["choice"], msg.get("convert"))}
    if mode == "hd":
        return {"ok": True, "message": download_with_ytdlp(url, cookies)}

    ensure_motrix()
    if mode == "direct":
        add_to_motrix(url)
        return {"ok": True, "message": "Sent to Motrix."}

    sort = ["-S", "res,fps,vcodec:h264,vcodec:av01,ext"] if mode == "best" else []
    info, fail = run_ytdlp_json(url, cookies, ["-f", FORMATS.get(mode, FORMATS["best"])] + sort)
    if fail:
        if fail.get("unsupported"):
            # Not a media page: probably a plain file link. Let Motrix have it.
            add_to_motrix(url)
            return {"ok": True, "message": "Sent to Motrix (plain file link)."}
        return fail

    entries = [e for e in (info.get("entries") or [info]) if e]
    sent, fallback = [], False
    for e in entries:
        parts = e.get("requested_formats")
        if parts and len(parts) == 2:
            if not all(is_http(f) for f in parts):
                fallback = True
                continue
            needs = convert if mode == "best" and codec_name(parts[0].get("vcodec")) not in ("H.264", "H.265") else ""
            send_merged(clean_title(e), parts[0], parts[1], needs)
            sent.append(clean_title(e))
            continue
        file_url = e.get("url")
        if not is_http(e):
            fallback = True
            continue
        headers = dict(e.get("http_headers") or {})
        if e.get("cookies"):
            headers["Cookie"] = e["cookies"]
        ext = e.get("ext")
        # Plain file links come back as "unknown_video": let Motrix keep the real name.
        if ext in (None, "unknown_video"):
            add_to_motrix(file_url)  # plain file link: let Motrix keep the real name
        else:
            codec = codec_name(e.get("vcodec")) if has(e, "vcodec") else "H.264"
            needs = convert if mode == "best" and codec not in ("H.264", "H.265") else ""
            send_single(clean_title(e), e, needs)
        sent.append(clean_title(e))
    if fallback and not sent:
        return {"ok": True, "message": "This one is a stream Motrix can't take. " + download_with_ytdlp(url, cookies)}
    if not sent:
        return {"ok": False, "error": "Couldn't find a downloadable file on that page."}
    title = sent[0] if len(sent) == 1 else "%d files" % len(sent)
    q = entries[0].get("height")
    return {"ok": True, "message": "Sent to Motrix: %s%s" % (title, " (%sp)" % q if q and mode != "audio" else "")}


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--merge":
        return merge_when_done(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    msg = read_message()
    try:
        send_message(handle(msg))
    except Exception as ex:
        log("error", repr(ex))
        send_message({"ok": False, "error": str(ex)})


if __name__ == "__main__":
    main()
