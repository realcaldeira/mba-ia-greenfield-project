import { UnsupportedMediaError } from './media.errors';
import { parseProbeOutput } from './probe-parser';

const METADATA_KEYS = [
  'audio_codec',
  'bit_rate',
  'format_name',
  'frame_rate',
  'height',
  'video_codec',
  'width',
];

function videoStream(overrides: Record<string, unknown> = {}) {
  return {
    index: 0,
    codec_name: 'h264',
    codec_type: 'video',
    width: 1920,
    height: 1080,
    avg_frame_rate: '30/1',
    disposition: { default: 1, attached_pic: 0 },
    ...overrides,
  };
}

function audioStream(overrides: Record<string, unknown> = {}) {
  return {
    index: 1,
    codec_name: 'aac',
    codec_type: 'audio',
    avg_frame_rate: '0/0',
    ...overrides,
  };
}

function probeJson(
  streams: unknown[],
  format: Record<string, unknown> = {},
): unknown {
  return {
    streams,
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '3.000000',
      bit_rate: '586829',
      ...format,
    },
  };
}

describe('parseProbeOutput', () => {
  it('should return the duration and exactly the seven metadata keys for an MP4 with audio', () => {
    const result = parseProbeOutput(probeJson([videoStream(), audioStream()]));

    expect(result.duration_seconds).toBe(3);
    expect(Object.keys(result.metadata).sort()).toEqual(METADATA_KEYS);
    expect(result.metadata).toEqual({
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      bit_rate: 586829,
      frame_rate: 30,
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    });
  });

  it('should set audio_codec to null when there is no audio stream', () => {
    const result = parseProbeOutput(probeJson([videoStream()]));

    expect(result.metadata.audio_codec).toBeNull();
    expect(Object.keys(result.metadata).sort()).toEqual(METADATA_KEYS);
  });

  it('should convert an avg_frame_rate fraction such as 30000/1001 to 29.97', () => {
    const result = parseProbeOutput(
      probeJson([videoStream({ avg_frame_rate: '30000/1001' })]),
    );

    expect(result.metadata.frame_rate).toBe(29.97);
  });

  it('should set frame_rate to null when avg_frame_rate is 0/0', () => {
    const result = parseProbeOutput(
      probeJson([videoStream({ avg_frame_rate: '0/0' })]),
    );

    expect(result.metadata.frame_rate).toBeNull();
  });

  it('should set duration_seconds and bit_rate to null when the format does not report them', () => {
    const result = parseProbeOutput(
      probeJson([videoStream()], { duration: 'N/A', bit_rate: undefined }),
    );

    expect(result.duration_seconds).toBeNull();
    expect(result.metadata.bit_rate).toBeNull();
  });

  it('should accept a WebM (matroska,webm) container', () => {
    const result = parseProbeOutput(
      probeJson([videoStream({ codec_name: 'vp8' })], {
        format_name: 'matroska,webm',
      }),
    );

    expect(result.metadata.format_name).toBe('matroska,webm');
    expect(result.metadata.video_codec).toBe('vp8');
  });

  it('should reject audio-only media with UnsupportedMediaError', () => {
    expect(() => parseProbeOutput(probeJson([audioStream()]))).toThrow(
      UnsupportedMediaError,
    );
  });

  it('should reject audio with cover art (attached picture) with UnsupportedMediaError', () => {
    const coverArt = videoStream({
      codec_name: 'mjpeg',
      disposition: { attached_pic: 1 },
    });

    expect(() =>
      parseProbeOutput(probeJson([audioStream(), coverArt])),
    ).toThrow(UnsupportedMediaError);
  });

  it('should reject a container outside the allowlist (avi) with UnsupportedMediaError', () => {
    expect(() =>
      parseProbeOutput(probeJson([videoStream()], { format_name: 'avi' })),
    ).toThrow(UnsupportedMediaError);
  });

  it('should reject output that is not a probe object with UnsupportedMediaError', () => {
    expect(() => parseProbeOutput('not json')).toThrow(UnsupportedMediaError);
    expect(() => parseProbeOutput({ streams: 'x', format: [] })).toThrow(
      UnsupportedMediaError,
    );
  });
});
