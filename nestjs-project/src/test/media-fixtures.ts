import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DURATION_SECONDS = 3;
const VIDEO_SOURCE = `testsrc=size=1920x1080:rate=30:duration=${DURATION_SECONDS}`;
const AUDIO_SOURCE = `sine=frequency=440:duration=${DURATION_SECONDS}`;
const RANDOM_BYTES_LENGTH = 256 * 1024;

// Media files generated at test time. No binary fixture is committed: every
// file lives in a fresh directory under the container's `os.tmpdir()`.
export interface MediaFixtures {
  dir: string;
  durationSeconds: number;
  faststartMp4: string;
  moovAtEndMp4: string;
  mov: string;
  webm: string;
  audioOnly: string;
  randomBytes: string;
}

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...args,
  ]);
}

async function assertFfmpegAvailable(): Promise<void> {
  try {
    await execFileAsync('ffmpeg', ['-version']);
  } catch {
    throw new Error(
      'ffmpeg is not available in this container; rebuild the image (docker compose up -d --build)',
    );
  }
}

const lavfiVideoAndAudio = [
  '-f',
  'lavfi',
  '-i',
  VIDEO_SOURCE,
  '-f',
  'lavfi',
  '-i',
  AUDIO_SOURCE,
  '-shortest',
];

const h264Aac = [
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
];

export async function generateMediaFixtures(): Promise<MediaFixtures> {
  await assertFfmpegAvailable();
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-media-'));

  const fixtures: MediaFixtures = {
    dir,
    durationSeconds: DURATION_SECONDS,
    faststartMp4: join(dir, 'faststart.mp4'),
    moovAtEndMp4: join(dir, 'moov-at-end.mp4'),
    mov: join(dir, 'video.mov'),
    webm: join(dir, 'video.webm'),
    audioOnly: join(dir, 'audio-only.m4a'),
    randomBytes: join(dir, 'random-bytes.mp4'),
  };

  try {
    await ffmpeg([
      ...lavfiVideoAndAudio,
      ...h264Aac,
      '-movflags',
      '+faststart',
      fixtures.faststartMp4,
    ]);
    // Without `+faststart` the mp4 muxer writes the moov atom after the media data.
    await ffmpeg([...lavfiVideoAndAudio, ...h264Aac, fixtures.moovAtEndMp4]);
    await ffmpeg([...lavfiVideoAndAudio, ...h264Aac, fixtures.mov]);
    await ffmpeg([
      ...lavfiVideoAndAudio,
      '-c:v',
      'libvpx',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-b:v',
      '1M',
      '-c:a',
      'libopus',
      fixtures.webm,
    ]);
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      AUDIO_SOURCE,
      '-c:a',
      'aac',
      fixtures.audioOnly,
    ]);
    await writeFile(fixtures.randomBytes, randomBytes(RANDOM_BYTES_LENGTH));
  } catch (error) {
    await removeMediaFixtures(fixtures);
    throw error;
  }

  return fixtures;
}

export async function removeMediaFixtures(
  fixtures: MediaFixtures,
): Promise<void> {
  await rm(fixtures.dir, { recursive: true, force: true });
}
