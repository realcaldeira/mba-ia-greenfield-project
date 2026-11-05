import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';
import queueConfig from './queue.config';
import storageConfig from './storage.config';

interface EnvValidationResult {
  error: ValidationError | undefined;
  value: Record<string, unknown>;
}

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

const validate = (env: Record<string, string>): EnvValidationResult =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue', () => {
  it('should apply the storage and queue defaults when only the S3 credentials are set', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'streamtube',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'streamtube',
      QUEUE_BACKOFF_DELAY_MS: 1000,
      QUEUE_ENQUEUE_TIMEOUT_MS: 5000,
      VIDEO_WORKER_CONCURRENCY: 1,
    });
  });

  it.each(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])(
    'should reject a missing %s',
    (key) => {
      const env: Record<string, string> = { ...requiredEnv };
      delete env[key];

      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it.each(['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT'])(
    'should reject %s without a URI scheme',
    (key) => {
      const { error } = validate({ [key]: 'minio:9000' });

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should reject a QUEUE_PREFIX containing ":"', () => {
    const { error } = validate({ QUEUE_PREFIX: 'stream:tube' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('QUEUE_PREFIX');
  });

  it.each([
    'QUEUE_BACKOFF_DELAY_MS',
    'QUEUE_ENQUEUE_TIMEOUT_MS',
    'VIDEO_WORKER_CONCURRENCY',
  ])('should reject %s below 1', (key) => {
    const { error } = validate({ [key]: '0' });

    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });
});

describe('storage and queue config namespaces', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should expose the validated defaults through the storage and queue namespaces', () => {
    const { value } = validate({});
    process.env = Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, String(val)]),
    );

    expect(storageConfig()).toEqual({
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://minio:9000',
      region: 'us-east-1',
      bucket: 'streamtube',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    });
    expect(queueConfig()).toEqual({
      host: 'redis',
      port: 6379,
      prefix: 'streamtube',
      backoffDelayMs: 1000,
      enqueueTimeoutMs: 5000,
      workerConcurrency: 1,
    });
  });
});
