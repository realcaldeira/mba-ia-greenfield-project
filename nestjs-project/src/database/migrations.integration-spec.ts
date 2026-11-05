import { DataSource } from 'typeorm';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1793849825000 } from './migrations/1793849825000-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';
import { ALL_ENTITIES } from '../test/test-entities';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];
describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, {
      synchronize: false,
      migrations: [
        CreateUsersAndChannels1775687773260,
        CreateAuthTokens1777579850478,
        CreateVideos1793849825000,
      ],
    });

    await dataSource.initialize();

    // One statement: concurrent DROP ... CASCADE on FK-related tables can deadlock.
    const tables = [...MANAGED_TABLES, 'migrations']
      .map((table) => `"${table}"`)
      .join(', ');
    await dataSource.query(`DROP TABLE IF EXISTS ${tables} CASCADE`);

    // DROP TABLE ... CASCADE keeps enum types created by the migrations, which
    // would make CREATE TYPE fail on the next run; drop every enum in the schema.
    const enums = await dataSource.query<{ typname: string }[]>(
      `SELECT t.typname FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE t.typtype = 'e' AND n.nspname = 'public'`,
    );
    if (enums.length > 0) {
      const types = enums.map((e) => `"public"."${e.typname}"`).join(', ');
      await dataSource.query(`DROP TYPE IF EXISTS ${types} CASCADE`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving the videos table missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove the videos table', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(result).toHaveLength(0);

    const remaining = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    expect(remaining.map((r) => r.table_name)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);

    const videoEnums = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type
       WHERE typname = ANY($1::text[])`,
      [['videos_status_enum', 'videos_processing_error_enum']],
    );
    expect(videoEnums).toHaveLength(0);
  });
});
