import { Injectable } from '@nestjs/common';
import {
  MEDIA_INPUT_GUARD_ARGS,
  MEDIA_PROCESS_TIMEOUT_MS,
} from './media.constants';
import { MediaProcessingError, UnsupportedMediaError } from './media.errors';
import { parseProbeOutput, type ProbeResult } from './probe-parser';
import { runProcess } from './process-runner';

// ffprobe's messages when the bytes match no known format, or only a demuxer
// outside the allowlist.
const UNSUPPORTED_INPUT_PATTERN =
  /Invalid data found when processing input|Format not on whitelist/i;

function parseJson(stdout: Buffer): unknown {
  try {
    return JSON.parse(stdout.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function isEmptyOutput(json: unknown): boolean {
  return (
    typeof json !== 'object' || json === null || Object.keys(json).length === 0
  );
}

@Injectable()
export class MediaProbeService {
  // Reads the original straight from the storage through a presigned URL; the
  // file is never copied to disk. Transient failures (non-zero exit for any
  // other reason, timeout, empty output) are rethrown as-is for a retry.
  async probe(url: string): Promise<ProbeResult> {
    const result = await runProcess(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        ...MEDIA_INPUT_GUARD_ARGS,
        url,
      ],
      { timeoutMs: MEDIA_PROCESS_TIMEOUT_MS },
    );

    if (result.exitCode !== 0) {
      if (UNSUPPORTED_INPUT_PATTERN.test(result.stderr)) {
        throw new UnsupportedMediaError('unrecognized or disallowed container');
      }
      throw new MediaProcessingError(
        'ffprobe',
        `exit code ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }

    const json = parseJson(result.stdout);
    if (isEmptyOutput(json)) {
      throw new MediaProcessingError('ffprobe', 'empty output');
    }
    return parseProbeOutput(json);
  }
}
