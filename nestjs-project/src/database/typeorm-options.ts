import type { ConfigType } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import type databaseConfig from '../config/database.config';

// Shared by the API (AppModule) and the video worker (WorkerModule): the
// connection parameters come only from the `database` config namespace.
export function typeOrmOptionsFactory(
  dbConfig: ConfigType<typeof databaseConfig>,
): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  };
}
