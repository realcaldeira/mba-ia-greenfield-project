import { extname } from 'node:path';
import {
  registerDecorator,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidationOptions,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { CONTENT_TYPE_EXTENSIONS } from '../videos.constants';

interface UploadFileFields {
  file_name?: unknown;
  content_type?: unknown;
}

function isKnownContentType(
  value: unknown,
): value is keyof typeof CONTENT_TYPE_EXTENSIONS {
  return (
    typeof value === 'string' && Object.hasOwn(CONTENT_TYPE_EXTENSIONS, value)
  );
}

@ValidatorConstraint({ name: 'matchesContentTypeExtension', async: false })
export class MatchesContentTypeExtensionConstraint implements ValidatorConstraintInterface {
  validate(fileName: unknown, args: ValidationArguments): boolean {
    const { content_type: contentType } = args.object as UploadFileFields;
    // An unknown content_type is reported by its own @IsIn rule.
    if (!isKnownContentType(contentType)) return true;
    if (typeof fileName !== 'string') return false;

    return (
      extname(fileName).toLowerCase() === CONTENT_TYPE_EXTENSIONS[contentType]
    );
  }

  defaultMessage(): string {
    const pairs = Object.entries(CONTENT_TYPE_EXTENSIONS)
      .map(([type, ext]) => `${ext} for ${type}`)
      .join(', ');
    return `file_name extension must match content_type (${pairs})`;
  }
}

// Class decorator: checks the file_name extension (case-insensitive) against
// CONTENT_TYPE_EXTENSIONS[content_type]. The error is reported on file_name.
export function MatchesContentTypeExtension(
  validationOptions?: ValidationOptions,
): ClassDecorator {
  return (target) => {
    registerDecorator({
      name: 'matchesContentTypeExtension',
      target,
      propertyName: 'file_name',
      options: validationOptions,
      validator: MatchesContentTypeExtensionConstraint,
    });
  };
}
