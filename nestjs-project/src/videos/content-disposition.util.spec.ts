import { buildAttachmentDisposition } from './content-disposition.util';

describe('buildAttachmentDisposition', () => {
  it('should keep an ASCII file name in both parameters', () => {
    expect(buildAttachmentDisposition('clip-final_v2.mp4')).toBe(
      `attachment; filename="clip-final_v2.mp4"; filename*=UTF-8''clip-final_v2.mp4`,
    );
  });

  it('should replace non-ASCII characters in the fallback and percent-encode them in UTF-8', () => {
    expect(buildAttachmentDisposition('Férias 2026.mp4')).toBe(
      `attachment; filename="F_rias 2026.mp4"; filename*=UTF-8''F%C3%A9rias%202026.mp4`,
    );
  });

  it('should replace each non-ASCII code point with a single underscore', () => {
    expect(buildAttachmentDisposition('a🎬b.mp4')).toContain(
      'filename="a_b.mp4"',
    );
  });

  it('should drop quotes and backslashes from the fallback', () => {
    const disposition = buildAttachmentDisposition('my "best" \\ clip.mp4');

    expect(disposition).toContain('filename="my best  clip.mp4"');
    expect(disposition).toContain(
      "filename*=UTF-8''my%20%22best%22%20%5C%20clip.mp4",
    );
  });

  it("should percent-encode ' ( ) and * to stay within the RFC 5987 attr-chars", () => {
    expect(buildAttachmentDisposition("it's (take*2).mp4")).toContain(
      "filename*=UTF-8''it%27s%20%28take%2A2%29.mp4",
    );
  });
});
