import { DomainException } from '../common/exceptions/domain.exception';

export class StorageUnavailableException extends DomainException {
  constructor() {
    super('STORAGE_UNAVAILABLE', 503, 'Storage is unavailable');
  }
}

// CompleteMultipartUpload refused the listed parts (EntityTooSmall, InvalidPart,
// InvalidPartOrder): a client-side problem with the upload, not an outage. The
// caller translates it into its own domain answer.
export class MultipartUploadRejectedException extends Error {
  constructor(public readonly reason: string) {
    super(`Multipart upload rejected by the storage: ${reason}`);
    this.name = MultipartUploadRejectedException.name;
  }
}

// CompleteMultipartUpload found no upload (NoSuchUpload): another completion
// consumed it first, or it was aborted. Whether the original was assembled is
// for the caller to check.
export class MultipartUploadMissingException extends Error {
  constructor() {
    super('Multipart upload no longer exists in the storage');
    this.name = MultipartUploadMissingException.name;
  }
}
