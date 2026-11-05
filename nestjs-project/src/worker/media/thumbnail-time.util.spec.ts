import { thumbnailTimeSeconds } from './thumbnail-time.util';

describe('thumbnailTimeSeconds', () => {
  it('should return 0 when the duration is unknown', () => {
    expect(thumbnailTimeSeconds(null)).toBe(0);
  });

  it('should return 0 when the duration is 0', () => {
    expect(thumbnailTimeSeconds(0)).toBe(0);
  });

  it('should return 10% of the duration for a short video', () => {
    expect(thumbnailTimeSeconds(3)).toBeCloseTo(0.3, 10);
  });

  it('should cap the time at 5 s for a long video', () => {
    expect(thumbnailTimeSeconds(120)).toBe(5);
  });

  it('should reach the 5 s cap exactly at 50 s', () => {
    expect(thumbnailTimeSeconds(50)).toBe(5);
  });
});
