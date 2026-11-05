// Upper bound for a single ffprobe/ffmpeg run reading the original by URL (TD-06).
export const MEDIA_PROCESS_TIMEOUT_MS = 120_000;

// ffprobe `format_name` entries accepted as containers (TD-06 allowlist).
export const ALLOWED_CONTAINER_FORMATS = [
  'mp4',
  'mov',
  'matroska',
  'webm',
] as const;

// Input hardening (TD-06), placed before the input URL on every ffprobe/ffmpeg
// run. The file is untrusted: only the protocols a presigned storage URL needs
// may be opened, and only the allowed container demuxers may parse it, so a
// playlist-like file (HLS, concat) cannot make the worker fetch other URLs or
// read local files.
export const MEDIA_INPUT_GUARD_ARGS = [
  '-protocol_whitelist',
  'http,https,tcp,tls',
  '-format_whitelist',
  ALLOWED_CONTAINER_FORMATS.join(','),
] as const;
