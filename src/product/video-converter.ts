import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Buyers see at most this much of a video; longer uploads keep their first 30 seconds. */
export const MAX_VIDEO_SECONDS = 30;
/** What a vendor may upload, before conversion. */
export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
/** WhatsApp takes videos up to 16 MB; this leaves room. */
export const MAX_CONVERTED_BYTES = 15 * 1024 * 1024;
/** The shorter side of the converted video, in pixels. */
const SHORT_SIDE = 720;
/** Conversion gives up after this long, so a strange file can't hold the queue for ever. */
const CONVERT_TIMEOUT_MS = 5 * 60 * 1000;

/** A conversion problem the vendor can act on; the message is shown to them. */
export class VideoRejected extends Error {}

/** Whether ffmpeg and ffprobe are installed (the Dockerfile installs them; developers install them locally). */
export async function videoToolsAvailable(): Promise<boolean> {
  try {
    await Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]);
    return true;
  } catch {
    return false;
  }
}

/** Length in seconds and whether the file has a video stream, read by ffprobe. */
export async function probeVideo(path: string): Promise<{ seconds: number; hasVideo: boolean }> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path], {
      timeout: 30_000,
    });
    const info = JSON.parse(stdout);
    const seconds = Number(info?.format?.duration);
    const hasVideo = (info?.streams ?? []).some((s: { codec_type?: string }) => s.codec_type === 'video');
    return { seconds: Number.isFinite(seconds) ? seconds : 0, hasVideo };
  } catch {
    return { seconds: 0, hasVideo: false };
  }
}

/**
 * Converts any phone video to what WhatsApp plays everywhere: MP4, H.264 + AAC, at most 720p
 * on the short side and MAX_VIDEO_SECONDS long, with the index at the front so it starts at
 * once. Re-encodes once at a lower quality if the result is too big. Also writes a JPEG still
 * from the first second, for admins. Throws VideoRejected for files we can't use.
 */
export async function convertVideo(input: string, output: string, poster: string): Promise<{ seconds: number; trimmed: boolean; bytes: number }> {
  const source = await probeVideo(input);
  if (!source.hasVideo) throw new VideoRejected('That file isn’t a video we can read. Record or choose an MP4 or MOV video.');
  if (source.seconds < 1) throw new VideoRejected('That video is too short. Record at least a few seconds.');

  for (const quality of [{ crf: 28, shortSide: SHORT_SIDE }, { crf: 33, shortSide: 480 }]) {
    await encode(input, output, quality);
    const { size } = await stat(output);
    if (size <= MAX_CONVERTED_BYTES) {
      await writePoster(output, poster);
      const seconds = Math.round(Math.min(source.seconds, MAX_VIDEO_SECONDS));
      return { seconds, trimmed: source.seconds > MAX_VIDEO_SECONDS + 0.5, bytes: size };
    }
  }
  throw new VideoRejected('That video is too detailed to send on WhatsApp. Try a shorter clip, or record in a lower quality.');
}

async function encode(input: string, output: string, { crf, shortSide }: { crf: number; shortSide: number }) {
  // Shrink so the shorter side is at most `shortSide`, keeping the shape; -2 keeps sizes even (H.264 needs that).
  const scale = `scale='if(lte(iw,ih),min(${shortSide},iw),-2)':'if(lte(iw,ih),-2,min(${shortSide},ih))'`;
  try {
    await run(
      'ffmpeg',
      [
        '-y', '-v', 'error',
        '-i', input,
        '-t', String(MAX_VIDEO_SECONDS),
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', `${scale},format=yuv420p`,
        '-r', '30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-profile:v', 'main',
        '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
        '-movflags', '+faststart',
        output,
      ],
      { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (err: any) {
    if (err?.killed) throw new VideoRejected('That video took too long to process. Try a shorter clip.');
    throw new VideoRejected('We couldn’t process that video. Try recording it again with your phone’s camera.');
  }
}

async function writePoster(video: string, poster: string) {
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', '0.5', '-i', video, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', poster], {
    timeout: 60_000,
  });
}
