import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { ALL_ENTITIES } from '../../test/test-entities';
import { User } from '../../users/entities/user.entity';
import {
  Video,
  VideoProcessingError,
  VideoStatus,
  type VideoMetadata,
} from './video.entity';

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_INVALID_TEXT_REPRESENTATION = '22P02';
const TEN_GIB = 10737418240;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_entity_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `video_chan_${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      id: randomUUID(),
      public_id: `pid${String(++counter).padStart(8, '0')}`,
      channel_id: channelId,
      title: 'My clip',
      original_filename: 'my-clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: 1024,
      upload_id: 'multipart-upload-id',
      upload_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      ...overrides,
    });
  }

  async function captureError(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error('Expected the operation to fail');
  }

  it('should reject a duplicate public_id with a unique violation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      buildVideo(channel.id, { public_id: 'AbCdEf_-123' }),
    );

    const err = await captureError(
      videoRepository.save(
        buildVideo(channel.id, { public_id: 'AbCdEf_-123' }),
      ),
    );

    expect(err).toBeInstanceOf(QueryFailedError);
    expect(err).toMatchObject({ code: PG_UNIQUE_VIOLATION });
  });

  it('should default status to draft and processing_error to null', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id);

    await videoRepository.insert(video);

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(persisted.status).toBe(VideoStatus.DRAFT);
    expect(persisted.processing_error).toBeNull();
    expect(persisted.duration_seconds).toBeNull();
    expect(persisted.metadata).toBeNull();
    expect(persisted.thumbnail_key).toBeNull();
  });

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();

    const err = await captureError(
      videoRepository.save(
        buildVideo(channel.id, { status: 'published' as VideoStatus }),
      ),
    );

    expect(err).toBeInstanceOf(QueryFailedError);
    expect(err).toMatchObject({ code: PG_INVALID_TEXT_REPRESENTATION });
  });

  it('should persist a failed video with a processing_error', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      buildVideo(channel.id, {
        status: VideoStatus.FAILED,
        processing_error: VideoProcessingError.UPLOAD_EXPIRED,
      }),
    );

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(persisted.processing_error).toBe(
      VideoProcessingError.UPLOAD_EXPIRED,
    );
  });

  it('should reject a channel_id without a matching channel', async () => {
    const err = await captureError(
      videoRepository.save(buildVideo(randomUUID())),
    );

    expect(err).toBeInstanceOf(QueryFailedError);
    expect(err).toMatchObject({ code: PG_FOREIGN_KEY_VIOLATION });
  });

  it('should read a 10 GiB size_bytes back as a number', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: TEN_GIB }),
    );

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(typeof persisted.size_bytes).toBe('number');
    expect(persisted.size_bytes).toBe(TEN_GIB);
  });

  it('should persist the seven metadata keys', async () => {
    const channel = await createChannel();
    const metadata: VideoMetadata = {
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: null,
      bit_rate: 4_500_000,
      frame_rate: 29.97,
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    };
    const video = await videoRepository.save(
      buildVideo(channel.id, {
        status: VideoStatus.READY,
        duration_seconds: 12.345,
        metadata,
      }),
    );

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(persisted.metadata).toEqual(metadata);
    expect(Object.keys(persisted.metadata!).sort()).toEqual(
      Object.keys(metadata).sort(),
    );
    expect(persisted.duration_seconds).toBe(12.345);
  });
});
