// Turns a Supabase / Postgres failure into a sentence a marketer can act on.

type Failure = {
  code?: string;
  message?: string;
};

const MESSAGE_BY_CODE: Record<string, string> = {
  // unique_violation
  '23505': 'That value is already in use. Choose a different one.',
  // foreign_key_violation
  '23503': 'This item is still used elsewhere, so it cannot be removed.',
  // insufficient_privilege, and the row level security refusal
  '42501': 'Your role does not allow this action.',
};

export function describeError(error: unknown, fallback = 'Something went wrong.') {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as Failure;

    if (code && MESSAGE_BY_CODE[code]) {
      return MESSAGE_BY_CODE[code];
    }

    if (message) {
      // Storage reports a refused upload this way.
      return /row-level security/i.test(message)
        ? MESSAGE_BY_CODE['42501']
        : message;
    }
  }

  return typeof error === 'string' && error ? error : fallback;
}
