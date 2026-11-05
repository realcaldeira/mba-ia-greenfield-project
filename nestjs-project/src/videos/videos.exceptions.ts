import { DomainException } from '../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class InvalidVideoStateException extends DomainException {
  constructor() {
    super(
      'INVALID_VIDEO_STATE',
      409,
      'Video is not in a valid state for this operation',
    );
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_INCOMPLETE',
      409,
      'Upload has missing or non-contiguous parts',
    );
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      409,
      'Uploaded size does not match the declared size',
    );
  }
}

export class UploadExpiredException extends DomainException {
  constructor() {
    super('UPLOAD_EXPIRED', 410, 'Upload window has expired');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}
