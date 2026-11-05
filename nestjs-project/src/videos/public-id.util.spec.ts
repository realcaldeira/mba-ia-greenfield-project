import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PublicIdParamDto } from './dto/public-id-param.dto';
import { generatePublicId } from './public-id.util';
import { PUBLIC_ID_PATTERN } from './videos.constants';

const GENERATIONS = 1000;

describe('generatePublicId', () => {
  it('should return 11 base64url characters matching PUBLIC_ID_PATTERN', () => {
    for (let i = 0; i < GENERATIONS; i++) {
      const id = generatePublicId();

      expect(id).toHaveLength(11);
      expect(id).toMatch(PUBLIC_ID_PATTERN);
    }
  });

  it('should return distinct values', () => {
    const ids = new Set(
      Array.from({ length: GENERATIONS }, () => generatePublicId()),
    );

    expect(ids.size).toBe(GENERATIONS);
  });
});

describe('PublicIdParamDto', () => {
  async function errorsFor(publicId: string): Promise<number> {
    const errors = await validate(
      plainToInstance(PublicIdParamDto, { publicId }),
    );
    return errors.length;
  }

  it('should accept a generated public id and a literal 11-char base64url id', async () => {
    await expect(errorsFor(generatePublicId())).resolves.toBe(0);
    await expect(errorsFor('AbCdEf_-123')).resolves.toBe(0);
  });

  it.each(['abc', 'AbCdEf_-1234', 'AbCdEf+/123', 'AbCdEf_-12='])(
    'should reject %p',
    async (publicId) => {
      await expect(errorsFor(publicId)).resolves.toBe(1);
    },
  );
});
