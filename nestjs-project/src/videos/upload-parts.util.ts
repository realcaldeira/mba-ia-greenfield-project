import { UPLOAD_PART_SIZE_BYTES } from './videos.constants';

// Number of multipart parts for a declared file size (TD-03: fixed part size).
export function partCount(sizeBytes: number): number {
  return Math.ceil(sizeBytes / UPLOAD_PART_SIZE_BYTES);
}

// Exact byte length of a part: part_size for every part but the last, which
// carries the remainder. Signed into each part URL.
export function partLength(sizeBytes: number, partNumber: number): number {
  const count = partCount(sizeBytes);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) {
    throw new RangeError(`part ${partNumber} is outside 1..${count}`);
  }
  return partNumber < count
    ? UPLOAD_PART_SIZE_BYTES
    : sizeBytes - UPLOAD_PART_SIZE_BYTES * (count - 1);
}
