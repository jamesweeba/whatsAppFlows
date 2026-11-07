/**
 * Runs the real ffmpeg on generated test clips. Skipped when ffmpeg isn't installed
 * (the Dockerfile installs it; locally: sudo apt install ffmpeg).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertVideo, MAX_CONVERTED_BYTES, probeVideo, VideoRejected, videoToolsAvailable } from './video-converter.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)('video converter (real ffmpeg)', { timeout: 60_000 }, () => {
  let dir = '';
  /** A test pattern clip with a tone, like a phone recording: 1080x1920 portrait, `seconds` long. */
  const clip = (name: string, seconds: number, size = '1080x1920') => {
    const path = join(dir, name);
    execFileSync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-shortest', path,
    ]);
    return path;
  };
  const dimensions = (path: string) => {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', path]).toString().trim();
    const [codec, width, height] = out.split(',');
    return { codec, width: Number(width), height: Number(height) };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'video-test-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the tools', async () => {
    expect(await videoToolsAvailable()).toBe(true);
  });

  it('converts a portrait phone clip to 720p H.264 MP4 with a poster', async () => {
    const out = join(dir, 'out.mp4');
    const poster = join(dir, 'poster.jpg');
    const result = await convertVideo(clip('phone.mov', 4), out, poster);

    expect(result).toMatchObject({ seconds: 4, trimmed: false });
    expect(result.bytes).toBeLessThan(MAX_CONVERTED_BYTES);
    expect(dimensions(out)).toEqual({ codec: 'h264', width: 720, height: 1280 });
    expect(statSync(poster).size).toBeGreaterThan(1000);
  });

  it('accepts MP4 and WebM as well as MOV', async () => {
    expect((await probeVideo(clip('a.mp4', 2))).hasVideo).toBe(true);
    const webm = join(dir, 'a.webm');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2', '-c:v', 'libvpx', '-b:v', '200k', webm]);
    expect((await probeVideo(webm)).hasVideo).toBe(true);
  });

  it('refuses a playlist dressed up as a video, so ffmpeg never opens the files it names', async () => {
    // An HLS playlist pointing at a real local video: without the whitelist ffmpeg would read it.
    const target = clip('secret.mp4', 2);
    const playlist = join(dir, 'upload');
    writeFileSync(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nfile://${target}\n#EXT-X-ENDLIST\n`);
    expect(await probeVideo(playlist)).toMatchObject({ hasVideo: false });
    await expect(convertVideo(playlist, join(dir, 'p.mp4'), join(dir, 'p.jpg'))).rejects.toBeInstanceOf(VideoRejected);

    const concat = join(dir, 'upload2');
    writeFileSync(concat, `ffconcat version 1.0\nfile '${target}'\n`);
    await expect(convertVideo(concat, join(dir, 'c.mp4'), join(dir, 'c.jpg'))).rejects.toBeInstanceOf(VideoRejected);
  });

  it('keeps only the first 30 seconds of a long clip', async () => {
    const out = join(dir, 'long-out.mp4');
    const result = await convertVideo(clip('long.mp4', 33, '320x240'), out, join(dir, 'long.jpg'));
    expect(result).toMatchObject({ seconds: 30, trimmed: true });
    expect(Math.round((await probeVideo(out)).seconds)).toBe(30);
  });

  it('turns down files that are not videos', async () => {
    const fake = join(dir, 'fake.mp4');
    writeFileSync(fake, 'not really a video');
    await expect(convertVideo(fake, join(dir, 'x.mp4'), join(dir, 'x.jpg'))).rejects.toBeInstanceOf(VideoRejected);
  });
});
