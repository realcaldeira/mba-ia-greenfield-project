import { streamTtlSeconds } from './media-url.util';

describe('streamTtlSeconds', () => {
  it('should fall back to the 1 h floor without a duration', () => {
    expect(streamTtlSeconds(null)).toBe(3600);
  });

  it('should keep the 1 h floor for a short video', () => {
    expect(streamTtlSeconds(60)).toBe(3600);
  });

  it('should be twice the duration between the floor and the ceiling', () => {
    expect(streamTtlSeconds(3600)).toBe(7200);
  });

  it('should cap at the 12 h ceiling for a long video', () => {
    expect(streamTtlSeconds(30000)).toBe(43200);
  });

  it('should round a fractional duration up to whole seconds', () => {
    expect(streamTtlSeconds(2000.2)).toBe(4001);
  });
});
