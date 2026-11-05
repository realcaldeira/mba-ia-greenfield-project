import { Injectable } from '@nestjs/common';
import { StorageService } from '../../storage/storage.service';
import { thumbnailKey } from '../../videos/video-storage-keys';
import { MEDIA_PROCESS_TIMEOUT_MS } from './media.constants';
import { MediaProcessingError } from './media.errors';
import { runProcess, type ProcessResult } from './process-runner';
import { thumbnailTimeSeconds } from './thumbnail-time.util';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';
// Every JPEG starts with the SOI marker FF D8.
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
// Width capped at 1280 px; -2 keeps the aspect ratio with an even height.
const SCALE_FILTER = "scale='min(1280,iw)':-2";

function isJpeg(result: ProcessResult): boolean {
  return (
    result.exitCode === 0 &&
    result.stdout.subarray(0, JPEG_SOI.length).equals(JPEG_SOI)
  );
}

@Injectable()
export class ThumbnailService {
  constructor(private readonly storage: StorageService) {}

  // Extracts one frame at min(10% of the duration, 5 s), read from the
  // presigned URL. When that frame cannot be produced (seek past the real end,
  // non-zero exit), falls back to t = 0; a failure at t = 0 is transient.
  async generate(url: string, durationSeconds: number | null): Promise<Buffer> {
    const time = thumbnailTimeSeconds(durationSeconds);
    let result = await this.extractFrame(url, time);

    if (!isJpeg(result) && time > 0) {
      result = await this.extractFrame(url, 0);
    }
    if (!isJpeg(result)) {
      throw new MediaProcessingError(
        'ffmpeg',
        `no frame extracted (exit code ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    return result.stdout;
  }

  async store(videoId: string, jpeg: Buffer): Promise<string> {
    const key = thumbnailKey(videoId);
    await this.storage.putObject(key, jpeg, THUMBNAIL_CONTENT_TYPE);
    return key;
  }

  private async extractFrame(
    url: string,
    timeSeconds: number,
  ): Promise<ProcessResult> {
    return runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(timeSeconds),
        '-i',
        url,
        '-frames:v',
        '1',
        '-vf',
        SCALE_FILTER,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      { timeoutMs: MEDIA_PROCESS_TIMEOUT_MS },
    );
  }
}
