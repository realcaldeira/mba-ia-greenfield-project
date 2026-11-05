// Upper bound for a single ffprobe/ffmpeg run reading the original by URL (TD-06).
export const MEDIA_PROCESS_TIMEOUT_MS = 120_000;

// ffprobe `format_name` entries accepted as containers (TD-06 allowlist).
export const ALLOWED_CONTAINER_FORMATS = [
  'mp4',
  'mov',
  'matroska',
  'webm',
] as const;
