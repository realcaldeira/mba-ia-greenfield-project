import type { VideoMetadata } from '../../videos/entities/video.entity';
import { ALLOWED_CONTAINER_FORMATS } from './media.constants';
import { UnsupportedMediaError } from './media.errors';

export interface ProbeResult {
  duration_seconds: number | null;
  metadata: VideoMetadata;
}

type JsonObject = Record<string, unknown>;

const FRAME_RATE_DECIMALS = 100;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  return null;
}

// ffprobe prints numbers inside `format` as strings ("3.000000", "586829").
function numericString(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// "30000/1001" → 29.97; "0/0" (unknown) → null.
function frameRate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return null;
  const rate = numerator / denominator;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(rate * FRAME_RATE_DECIMALS) / FRAME_RATE_DECIMALS;
}

function streamsOf(probe: JsonObject): JsonObject[] {
  return Array.isArray(probe.streams) ? probe.streams.filter(isObject) : [];
}

// Cover art in audio files is reported as a video stream with attached_pic = 1.
function isVideoStream(stream: JsonObject): boolean {
  const disposition = isObject(stream.disposition) ? stream.disposition : {};
  return stream.codec_type === 'video' && disposition.attached_pic !== 1;
}

function isAllowedContainer(formatName: string): boolean {
  const names = formatName.split(',');
  return ALLOWED_CONTAINER_FORMATS.some((allowed) => names.includes(allowed));
}

// Turns the JSON printed by `ffprobe -show_format -show_streams` into the video
// metadata (TD-06 "Metadata shape"). The input is untrusted: every field is
// checked before use. Media without a video stream or outside the container
// allowlist is rejected with UnsupportedMediaError.
export function parseProbeOutput(json: unknown): ProbeResult {
  const probe = isObject(json) ? json : {};
  const streams = streamsOf(probe);
  const format = isObject(probe.format) ? probe.format : {};

  const video = streams.find(isVideoStream);
  if (!video) {
    throw new UnsupportedMediaError('no video stream');
  }

  const formatName = stringOrNull(format.format_name);
  if (!formatName || !isAllowedContainer(formatName)) {
    throw new UnsupportedMediaError(
      `container "${formatName ?? 'unknown'}" is not allowed`,
    );
  }

  const width = positiveIntegerOrNull(video.width);
  const height = positiveIntegerOrNull(video.height);
  const videoCodec = stringOrNull(video.codec_name);
  if (width === null || height === null || videoCodec === null) {
    throw new UnsupportedMediaError('video stream without dimensions or codec');
  }

  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const bitRate = numericString(format.bit_rate);

  return {
    duration_seconds: numericString(format.duration),
    metadata: {
      width,
      height,
      video_codec: videoCodec,
      audio_codec: audio ? stringOrNull(audio.codec_name) : null,
      bit_rate: bitRate === null ? null : Math.round(bitRate),
      frame_rate: frameRate(video.avg_frame_rate),
      format_name: formatName,
    },
  };
}
