import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_SIGNING_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

async function endpointOf(client: S3Client): Promise<string> {
  const endpoint = await client.config.endpoint!();
  return `${endpoint.protocol}//${endpoint.hostname}:${endpoint.port}`;
}

describe('StorageModule', () => {
  it('should compile with storageConfig and expose both clients', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    const cfg = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    const internal = moduleRef.get<S3Client>(S3_INTERNAL_CLIENT);
    const signing = moduleRef.get<S3Client>(S3_SIGNING_CLIENT);

    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
    expect(internal).toBeInstanceOf(S3Client);
    expect(signing).toBeInstanceOf(S3Client);
    expect(internal).not.toBe(signing);
    expect(await endpointOf(internal)).toBe(new URL(cfg.endpoint).origin);
    expect(await endpointOf(signing)).toBe(new URL(cfg.publicEndpoint).origin);
    expect(internal.config.forcePathStyle).toBe(true);
    expect(signing.config.forcePathStyle).toBe(true);

    await moduleRef.close();
  });

  it('should destroy both clients on module close', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    const internalDestroy = jest.spyOn(
      moduleRef.get<S3Client>(S3_INTERNAL_CLIENT),
      'destroy',
    );
    const signingDestroy = jest.spyOn(
      moduleRef.get<S3Client>(S3_SIGNING_CLIENT),
      'destroy',
    );

    await moduleRef.close();

    expect(internalDestroy).toHaveBeenCalledTimes(1);
    expect(signingDestroy).toHaveBeenCalledTimes(1);
  });
});
