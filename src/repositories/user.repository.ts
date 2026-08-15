import { query, queryOne } from '../db/pool';
import type { PublicUser, UserRole, UserRow } from '../types';

/**
 * User data access.
 *
 * Repositories own SQL and row-to-domain mapping, and nothing else. No
 * validation, no hashing, no authorisation decisions — those belong to the
 * service layer, which is what keeps this file readable and swappable.
 */

const COLUMNS = 'id, name, email, password_hash, phone, role, created_at, updated_at';

/** Strips the password hash and converts the row to the API shape. */
export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const userRepository = {
  async findById(id: string): Promise<UserRow | null> {
    return queryOne<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  },

  /**
   * Case-insensitive lookup. Matches the `users_email_lower_key` unique index,
   * so this is an index scan rather than a sequential scan.
   */
  async findByEmail(email: string): Promise<UserRow | null> {
    return queryOne<UserRow>(`SELECT ${COLUMNS} FROM users WHERE lower(email) = lower($1)`, [
      email,
    ]);
  },

  async create(input: {
    name: string;
    email: string;
    passwordHash: string;
    phone: string | null;
    role?: UserRole;
  }): Promise<UserRow> {
    const { rows } = await query<UserRow>(
      `INSERT INTO users (name, email, password_hash, phone, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [input.name, input.email.toLowerCase(), input.passwordHash, input.phone, input.role ?? 'USER'],
    );
    return rows[0]!;
  },

  /**
   * Partial profile update.
   *
   * The SET clause is assembled from whichever fields were supplied, with every
   * value still passed as a bound parameter. Column names come from this
   * function's own literals, never from caller input, so there is no injection
   * surface.
   */
  async update(
    id: string,
    changes: { name?: string; phone?: string | null },
  ): Promise<UserRow | null> {
    const assignments: string[] = [];
    const values: unknown[] = [];

    if (changes.name !== undefined) {
      values.push(changes.name);
      assignments.push(`name = $${values.length}`);
    }
    if (changes.phone !== undefined) {
      values.push(changes.phone);
      assignments.push(`phone = $${values.length}`);
    }
    if (assignments.length === 0) return this.findById(id);

    values.push(id);
    return queryOne<UserRow>(
      `UPDATE users SET ${assignments.join(', ')} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
      values,
    );
  },

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
  },

  async emailExists(email: string): Promise<boolean> {
    const row = await queryOne<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM users WHERE lower(email) = lower($1)) AS exists',
      [email],
    );
    return row?.exists ?? false;
  },
};
