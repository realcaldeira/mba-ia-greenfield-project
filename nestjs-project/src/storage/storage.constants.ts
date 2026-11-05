// Server-side operations, against S3_ENDPOINT.
export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');
// Signs the URLs handed to clients, against S3_PUBLIC_ENDPOINT: SigV4 binds the host.
export const S3_SIGNING_CLIENT = Symbol('S3_SIGNING_CLIENT');
