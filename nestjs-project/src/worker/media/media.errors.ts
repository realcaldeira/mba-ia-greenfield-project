// The media cannot be processed and never will be (no video stream, container
// outside the allowlist, data ffprobe does not recognize): the job must fail
// without retries.
export class UnsupportedMediaError extends Error {
  constructor(reason: string) {
    super(`Unsupported media: ${reason}`);
    this.name = 'UnsupportedMediaError';
  }
}

// A media tool failed for a reason that may go away on retry (storage
// unreachable, signed URL rejected, process killed).
export class MediaProcessingError extends Error {
  constructor(command: string, detail: string) {
    super(`${command} failed: ${detail}`);
    this.name = 'MediaProcessingError';
  }
}
