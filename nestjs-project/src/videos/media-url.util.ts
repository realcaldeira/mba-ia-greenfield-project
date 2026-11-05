import {
  STREAM_TTL_MAX_SECONDS,
  STREAM_TTL_MIN_SECONDS,
} from './videos.constants';

// Each Range request of the player is a new signed request, so the stream URL
// must outlive the playback: clamp(2 × duration, 1 h, 12 h); 1 h without duration.
export function streamTtlSeconds(durationSeconds: number | null): number {
  if (durationSeconds === null) {
    return STREAM_TTL_MIN_SECONDS;
  }
  return Math.min(
    Math.max(Math.ceil(2 * durationSeconds), STREAM_TTL_MIN_SECONDS),
    STREAM_TTL_MAX_SECONDS,
  );
}
