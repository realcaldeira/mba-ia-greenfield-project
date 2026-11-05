import { partCount, partLength } from './upload-parts.util';
import {
  VIDEO_MAX_SIZE_BYTES,
  UPLOAD_PART_SIZE_BYTES,
} from './videos.constants';

describe('upload parts util', () => {
  describe('partCount', () => {
    it('should return one part for a file smaller than part_size', () => {
      expect(partCount(1)).toBe(1);
    });

    it('should return an exact count when the size is a multiple of part_size', () => {
      expect(partCount(UPLOAD_PART_SIZE_BYTES * 3)).toBe(3);
    });

    it('should round up when the last part is partial', () => {
      expect(partCount(UPLOAD_PART_SIZE_BYTES * 3 + 1)).toBe(4);
    });

    it('should return 160 parts for the 10 GiB limit', () => {
      expect(partCount(VIDEO_MAX_SIZE_BYTES)).toBe(160);
    });
  });

  describe('partLength', () => {
    it('should return part_size for every part but the last', () => {
      const size = UPLOAD_PART_SIZE_BYTES * 2 + 100;

      expect(partLength(size, 1)).toBe(UPLOAD_PART_SIZE_BYTES);
      expect(partLength(size, 2)).toBe(UPLOAD_PART_SIZE_BYTES);
    });

    it('should return the remainder for the last part', () => {
      expect(partLength(UPLOAD_PART_SIZE_BYTES * 2 + 100, 3)).toBe(100);
    });

    it('should return part_size for the last part of an exact multiple', () => {
      expect(partLength(UPLOAD_PART_SIZE_BYTES * 2, 2)).toBe(
        UPLOAD_PART_SIZE_BYTES,
      );
    });

    it('should return the whole size for a single-part file', () => {
      expect(partLength(1024, 1)).toBe(1024);
    });

    it.each([0, 4, 1.5])(
      'should throw RangeError for part %p outside 1..part_count',
      (partNumber) => {
        expect(() =>
          partLength(UPLOAD_PART_SIZE_BYTES * 2 + 100, partNumber),
        ).toThrow(RangeError);
      },
    );
  });
});
