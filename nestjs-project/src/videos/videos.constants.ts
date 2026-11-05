// Upload protocol (TD-03): 10 GiB ceiling, 64 MiB parts (at most 160), 1 h part URLs, 24 h window.
export const VIDEO_MAX_SIZE_BYTES = 10737418240;
export const UPLOAD_PART_SIZE_BYTES = 67108864;
export const PART_URL_TTL_SECONDS = 3600;
export const UPLOAD_WINDOW_HOURS = 24;

// Allowed declared content types and the file extension each one requires.
export const CONTENT_TYPE_EXTENSIONS = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
} as const;

export type VideoContentType = keyof typeof CONTENT_TYPE_EXTENSIONS;

export const ALLOWED_VIDEO_CONTENT_TYPES = Object.keys(
  CONTENT_TYPE_EXTENSIONS,
) as VideoContentType[];

// Presigned media URLs (TD-08): stream TTL is clamp(2 × duration, min, max).
export const STREAM_TTL_MIN_SECONDS = 3600;
export const STREAM_TTL_MAX_SECONDS = 43200;
export const DOWNLOAD_TTL_SECONDS = 3600;
export const THUMBNAIL_URL_TTL_SECONDS = 3600;

// 11 base64url characters: 8 random bytes (TD-07).
export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
