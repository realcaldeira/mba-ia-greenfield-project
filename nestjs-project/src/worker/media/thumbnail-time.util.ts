// TD-06: the thumbnail frame is taken at 10% of the duration, capped at 5 s,
// so it skips black intro frames without seeking deep into long videos.
const THUMBNAIL_DURATION_FRACTION = 0.1;
const THUMBNAIL_MAX_SECONDS = 5;

export function thumbnailTimeSeconds(durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return Math.min(
    THUMBNAIL_DURATION_FRACTION * durationSeconds,
    THUMBNAIL_MAX_SECONDS,
  );
}
