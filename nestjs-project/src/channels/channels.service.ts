import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isUniqueViolation } from '../database/pg-errors';
import { appendRandomSuffix, sanitizeNickname } from './nickname.util';
import { Channel } from './entities/channel.entity';

const NICKNAME_COLUMN = 'nickname';
const MAX_RETRIES = 5;
const INSERT_SAVEPOINT = 'channel_insert';

@Injectable()
export class ChannelsService {
  constructor(private readonly dataSource: DataSource) {}

  async findByUserId(userId: string): Promise<Channel | null> {
    return this.dataSource
      .getRepository(Channel)
      .findOne({ where: { user_id: userId } });
  }

  async createChannel(userId: string, email: string): Promise<Channel> {
    const baseNickname = sanitizeNickname(email.split('@')[0]);

    return this.dataSource.transaction(async (manager) => {
      let nickname = baseNickname;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const existing = await manager.findOne(Channel, {
          where: { nickname },
        });
        if (existing) {
          nickname = appendRandomSuffix(baseNickname);
          continue;
        }

        // A failed statement aborts the whole Postgres transaction; the savepoint
        // lets the next attempt run after a unique violation.
        await manager.query(`SAVEPOINT ${INSERT_SAVEPOINT}`);
        try {
          const saved = await manager.save(
            manager.create(Channel, {
              name: baseNickname,
              nickname,
              user_id: userId,
            }),
          );
          await manager.query(`RELEASE SAVEPOINT ${INSERT_SAVEPOINT}`);
          return saved;
        } catch (err) {
          await manager.query(`ROLLBACK TO SAVEPOINT ${INSERT_SAVEPOINT}`);
          if (isUniqueViolation(err, { column: NICKNAME_COLUMN })) {
            // Concurrent insert between pre-check and save — retry with new suffix
            nickname = appendRandomSuffix(baseNickname);
          } else {
            throw err;
          }
        }
      }

      throw new Error(
        'Nickname conflict could not be resolved after max retries',
      );
    });
  }
}
