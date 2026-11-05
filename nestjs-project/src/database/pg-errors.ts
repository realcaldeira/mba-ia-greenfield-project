import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';

// node-postgres error fields; TypeORM copies them onto the QueryFailedError itself.
export interface PgErrorFields {
  code: unknown;
  detail: unknown;
  constraint: unknown;
}

export type PgQueryFailedError = QueryFailedError & PgErrorFields;

export function isPgQueryFailedError(err: unknown): err is PgQueryFailedError {
  return err instanceof QueryFailedError && 'code' in err;
}

// A unique violation on `column` (Postgres detail `Key (column)=(...) already
// exists.`) or on the named `constraint`. Any other error, or a unique
// violation on another key, is not a match.
export function isUniqueViolation(
  err: unknown,
  target: { column?: string; constraint?: string },
): boolean {
  if (!isPgQueryFailedError(err) || err.code !== PG_UNIQUE_VIOLATION) {
    return false;
  }
  const onColumn =
    target.column !== undefined &&
    typeof err.detail === 'string' &&
    err.detail.startsWith(`Key (${target.column})=`);
  const onConstraint =
    target.constraint !== undefined && err.constraint === target.constraint;
  return onColumn || onConstraint;
}
