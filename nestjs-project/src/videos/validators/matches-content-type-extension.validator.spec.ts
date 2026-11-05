import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { InitiateUploadDto } from '../dto/initiate-upload.dto';

const EXTENSION_CONSTRAINT = 'matchesContentTypeExtension';

async function validateUpload(
  overrides: Record<string, unknown>,
): Promise<ValidationError[]> {
  return validate(
    plainToInstance(InitiateUploadDto, {
      file_name: 'clip.mp4',
      file_size: 1024,
      content_type: 'video/mp4',
      ...overrides,
    }),
  );
}

function constraintsOf(
  errors: ValidationError[],
  property: string,
): Record<string, string> {
  return errors.find((error) => error.property === property)?.constraints ?? {};
}

describe('MatchesContentTypeExtension', () => {
  it('should accept .mp4 with video/mp4', async () => {
    await expect(validateUpload({})).resolves.toEqual([]);
  });

  it('should accept an upper-case .MKV with video/x-matroska', async () => {
    await expect(
      validateUpload({
        file_name: 'HOLIDAY.MKV',
        content_type: 'video/x-matroska',
      }),
    ).resolves.toEqual([]);
  });

  it('should reject .mov declared as video/mp4 with a message about the extension', async () => {
    const errors = await validateUpload({ file_name: 'clip.mov' });

    const constraints = constraintsOf(errors, 'file_name');
    expect(Object.keys(constraints)).toEqual([EXTENSION_CONSTRAINT]);
    expect(constraints[EXTENSION_CONSTRAINT]).toMatch(/extension/);
  });

  it('should reject a file name without an extension', async () => {
    const errors = await validateUpload({ file_name: 'clip' });

    expect(Object.keys(constraintsOf(errors, 'file_name'))).toEqual([
      EXTENSION_CONSTRAINT,
    ]);
  });

  it('should leave an unknown content_type to its own allowlist rule', async () => {
    const errors = await validateUpload({
      file_name: 'clip.avi',
      content_type: 'video/x-msvideo',
    });

    expect(errors.map((error) => error.property)).toEqual(['content_type']);
  });
});

describe('InitiateUploadDto title', () => {
  it('should reject a title that is empty after trimming', async () => {
    const errors = await validateUpload({ title: '   ' });

    expect(Object.keys(constraintsOf(errors, 'title'))).toEqual(['isLength']);
  });

  it('should trim the title before validating it', async () => {
    const dto = plainToInstance(InitiateUploadDto, {
      file_name: 'clip.mp4',
      file_size: 1024,
      content_type: 'video/mp4',
      title: '  My trip  ',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.title).toBe('My trip');
  });
});
