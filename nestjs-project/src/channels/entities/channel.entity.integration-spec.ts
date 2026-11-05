import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Channel } from './channel.entity';
import { Video } from '../../videos/entities/video.entity';
import { ALL_ENTITIES } from '../../test/test-entities';

describe('Channel entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUser(): Promise<User> {
    return userRepository.save(
      userRepository.create({
        email: `ch_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
  }

  it('should enforce unique nickname constraint', async () => {
    const user1 = await createUser();
    const user2 = await createUser();

    await channelRepository.save(
      channelRepository.create({
        name: 'Channel One',
        nickname: 'chan',
        user_id: user1.id,
      }),
    );

    await expect(
      channelRepository.save(
        channelRepository.create({
          name: 'Channel Two',
          nickname: 'chan',
          user_id: user2.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce nickname max length of 50 characters', async () => {
    const user = await createUser();
    const longNickname = 'a'.repeat(51);

    await expect(
      channelRepository.save(
        channelRepository.create({
          name: 'Chan',
          nickname: longNickname,
          user_id: user.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should allow null description', async () => {
    const user = await createUser();
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Chan',
        nickname: 'chan',
        user_id: user.id,
        description: null,
      }),
    );

    expect(channel.description).toBeNull();
  });

  it('should enforce one-to-one relation: one user_id per channel', async () => {
    const user = await createUser();

    await channelRepository.save(
      channelRepository.create({
        name: 'Chan',
        nickname: 'chan1',
        user_id: user.id,
      }),
    );

    await expect(
      channelRepository.save(
        channelRepository.create({
          name: 'Chan2',
          nickname: 'chan2',
          user_id: user.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load the related user via the OneToOne relation', async () => {
    const user = await createUser();
    await channelRepository.save(
      channelRepository.create({
        name: 'Chan',
        nickname: 'relchan',
        user_id: user.id,
      }),
    );

    const found = await channelRepository.findOne({
      where: { nickname: 'relchan' },
      relations: ['user'],
    });

    expect(found?.user.email).toBe(user.email);
  });

  it('should load the channel videos via the OneToMany relation', async () => {
    const user = await createUser();
    const other = await createUser();
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Chan',
        nickname: 'vidchan',
        user_id: user.id,
      }),
    );
    const otherChannel = await channelRepository.save(
      channelRepository.create({
        name: 'Other',
        nickname: 'otherchan',
        user_id: other.id,
      }),
    );
    const videoRepository = dataSource.getRepository(Video);
    const buildVideo = (channelId: string, publicId: string): Video =>
      videoRepository.create({
        id: randomUUID(),
        public_id: publicId,
        channel_id: channelId,
        title: 'Clip',
        original_filename: 'clip.mp4',
        mime_type: 'video/mp4',
        size_bytes: 1024,
        upload_id: 'upload-id',
        upload_expires_at: new Date(Date.now() + 86_400_000),
      });
    await videoRepository.save([
      buildVideo(channel.id, 'AAAAAAAAAA1'),
      buildVideo(channel.id, 'AAAAAAAAAA2'),
      buildVideo(otherChannel.id, 'AAAAAAAAAA3'),
    ]);

    const found = await channelRepository.findOne({
      where: { id: channel.id },
      relations: ['videos'],
    });

    expect(found?.videos.map((v) => v.public_id).sort()).toEqual([
      'AAAAAAAAAA1',
      'AAAAAAAAAA2',
    ]);
  });
});
