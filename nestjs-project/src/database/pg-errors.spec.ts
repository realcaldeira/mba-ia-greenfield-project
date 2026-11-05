import { QueryFailedError } from 'typeorm';
import { isPgQueryFailedError, isUniqueViolation } from './pg-errors';

function queryFailed(fields: Record<string, unknown>): QueryFailedError {
  return Object.assign(new QueryFailedError('INSERT', [], new Error()), fields);
}

function uniqueViolation(column: string, constraint: string): QueryFailedError {
  return queryFailed({
    code: '23505',
    detail: `Key (${column})=(x) already exists.`,
    constraint,
  });
}

describe('pg-errors', () => {
  describe('isPgQueryFailedError', () => {
    it('should accept a QueryFailedError carrying the Postgres code', () => {
      expect(isPgQueryFailedError(uniqueViolation('id', 'PK_videos'))).toBe(
        true,
      );
    });

    it('should reject a plain Error with a code', () => {
      expect(
        isPgQueryFailedError(
          Object.assign(new Error('boom'), { code: '23505' }),
        ),
      ).toBe(false);
    });

    it('should reject a QueryFailedError without a Postgres code', () => {
      expect(isPgQueryFailedError(queryFailed({}))).toBe(false);
    });
  });

  describe('isUniqueViolation', () => {
    it('should match a unique violation on the given column', () => {
      const err = uniqueViolation('public_id', 'UQ_videos_public_id');

      expect(isUniqueViolation(err, { column: 'public_id' })).toBe(true);
    });

    it('should match a unique violation on the given constraint', () => {
      const err = uniqueViolation('public_id', 'UQ_videos_public_id');

      expect(
        isUniqueViolation(err, { constraint: 'UQ_videos_public_id' }),
      ).toBe(true);
    });

    it('should not match a unique violation on another column', () => {
      const err = uniqueViolation('id', 'PK_videos');

      expect(isUniqueViolation(err, { column: 'public_id' })).toBe(false);
    });

    it('should not match a column whose name only contains the target', () => {
      const err = uniqueViolation('channel_nickname', 'UQ_x');

      expect(isUniqueViolation(err, { column: 'nickname' })).toBe(false);
    });

    it('should not match another Postgres error on the same column', () => {
      const err = queryFailed({
        code: '23502',
        detail: 'Key (public_id)=(x) violates not-null constraint.',
      });

      expect(isUniqueViolation(err, { column: 'public_id' })).toBe(false);
    });

    it('should not match an error that is not a QueryFailedError', () => {
      const err = Object.assign(new Error('boom'), {
        code: '23505',
        detail: 'Key (public_id)=(x) already exists.',
      });

      expect(isUniqueViolation(err, { column: 'public_id' })).toBe(false);
    });
  });
});
