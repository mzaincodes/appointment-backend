import type { PoolClient } from 'pg';
import { query, queryOne } from '../db/pool';
import { clinicNow, clinicToday, normaliseTime } from '../utils/datetime';
import type {
  Appointment,
  AppointmentFilters,
  AppointmentRow,
  AppointmentStats,
  CreateAppointmentInput,
  UpdateAppointmentInput,
} from '../types';

/**
 * Appointment data access.
 *
 * All SQL for appointments lives here. Methods accept an optional `PoolClient`
 * so the service layer can run them inside a transaction — that is what makes
 * the booking path atomic without the repository knowing anything about
 * transactions itself.
 */

const SELECT_COLUMNS = `
    a.id, a.user_id, a.patient_name, a.patient_email, a.patient_phone,
    a.appointment_date, a.start_time, a.end_time, a.service_id,
    a.reason, a.notes, a.status, a.source,
    a.cancelled_at, a.completed_at, a.created_at, a.updated_at,
    s.name AS service_name, s.slug AS service_slug`;

const FROM_CLAUSE = `FROM appointments a LEFT JOIN services s ON s.id = a.service_id`;

/** Row -> API shape. Times are trimmed from `HH:mm:ss` to `HH:mm`. */
export function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    userId: row.user_id,
    patientName: row.patient_name,
    patientEmail: row.patient_email,
    patientPhone: row.patient_phone,
    appointmentDate: row.appointment_date,
    startTime: normaliseTime(row.start_time),
    endTime: normaliseTime(row.end_time),
    serviceId: row.service_id,
    serviceName: row.service_name ?? null,
    reason: row.reason,
    notes: row.notes,
    status: row.status,
    source: row.source,
    cancelledAt: row.cancelled_at ? row.cancelled_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Runs against a transaction client when given one, else the pool. */
async function run<T extends AppointmentRow>(
  client: PoolClient | undefined,
  text: string,
  params: readonly unknown[],
): Promise<T[]> {
  if (client) {
    const result = await client.query<T>(text, params as unknown[]);
    return result.rows;
  }
  const { rows } = await query<T>(text, params);
  return rows;
}

export const appointmentRepository = {
  async findById(id: string, client?: PoolClient): Promise<Appointment | null> {
    const rows = await run<AppointmentRow>(
      client,
      `SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE} WHERE a.id = $1`,
      [id],
    );
    return rows[0] ? toAppointment(rows[0]) : null;
  },

  /**
   * Occupied start times for a date.
   *
   * The heart of availability. `status <> 'CANCELLED'` is the rule expressed
   * once here and once in the `appointments_no_overlap` exclusion constraint —
   * COMPLETED appointments continue to hold their slot, cancelled ones release
   * it.
   *
   * Uses `appointments_date_start_time_idx`, which also returns the rows
   * already ordered by start time.
   */
  async findOccupiedTimes(date: string, client?: PoolClient): Promise<string[]> {
    const text = `SELECT start_time FROM appointments
                  WHERE appointment_date = $1 AND status <> 'CANCELLED'
                  ORDER BY start_time`;
    const rows = client
      ? (await client.query<{ start_time: string }>(text, [date])).rows
      : (await query<{ start_time: string }>(text, [date])).rows;
    return rows.map((row) => normaliseTime(row.start_time));
  },

  /**
   * Occupied times across a date range, grouped by date.
   *
   * One round trip for the whole calendar month instead of one per day.
   */
  async findOccupiedTimesInRange(from: string, to: string): Promise<Map<string, string[]>> {
    const { rows } = await query<{ appointment_date: string; times: string[] }>(
      `SELECT appointment_date, array_agg(start_time::text ORDER BY start_time) AS times
       FROM appointments
       WHERE appointment_date BETWEEN $1 AND $2 AND status <> 'CANCELLED'
       GROUP BY appointment_date`,
      [from, to],
    );

    const map = new Map<string, string[]>();
    for (const row of rows) {
      map.set(row.appointment_date, row.times.map(normaliseTime));
    }
    return map;
  },

  /**
   * Is this exact slot free?
   *
   * `FOR UPDATE` is intentionally *not* used: there is no row to lock when the
   * slot is empty, so locking cannot prevent two transactions from both finding
   * it free. The exclusion constraint on INSERT is what actually serialises
   * them. This check exists to produce a friendly error in the common,
   * uncontended case — see the note in appointment.service.ts.
   */
  async isSlotTaken(
    date: string,
    startTime: string,
    excludeId: string | null,
    client?: PoolClient,
  ): Promise<boolean> {
    const text = `SELECT 1 FROM appointments
                  WHERE appointment_date = $1
                    AND start_time = $2
                    AND status <> 'CANCELLED'
                    AND ($3::uuid IS NULL OR id <> $3)
                  LIMIT 1`;
    const params = [date, startTime, excludeId];
    const rows = client
      ? (await client.query(text, params)).rows
      : (await query(text, params)).rows;
    return rows.length > 0;
  },

  async create(input: CreateAppointmentInput & { endTime: string }, client?: PoolClient): Promise<Appointment> {
    const rows = await run<AppointmentRow>(
      client,
      `WITH inserted AS (
         INSERT INTO appointments (
           user_id, patient_name, patient_email, patient_phone,
           appointment_date, start_time, end_time,
           service_id, reason, notes, source
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *
       )
       SELECT ${SELECT_COLUMNS}
       FROM inserted a LEFT JOIN services s ON s.id = a.service_id`,
      [
        input.userId,
        input.patientName,
        input.patientEmail,
        input.patientPhone,
        input.appointmentDate,
        input.startTime,
        input.endTime,
        input.serviceId ?? null,
        input.reason,
        input.notes ?? null,
        input.source ?? 'WEB',
      ],
    );
    return toAppointment(rows[0]!);
  },

  /**
   * Partial update.
   *
   * The SET list is built from supplied fields only; column names are this
   * function's own literals and every value is bound, so there is no injection
   * surface. Status changes also maintain `cancelled_at` / `completed_at`,
   * which the database CHECK constraints require to agree with the status.
   */
  async update(
    id: string,
    changes: UpdateAppointmentInput & { endTime?: string },
    client?: PoolClient,
  ): Promise<Appointment | null> {
    const assignments: string[] = [];
    const values: unknown[] = [];

    const set = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (changes.patientName !== undefined) set('patient_name', changes.patientName);
    if (changes.patientEmail !== undefined) set('patient_email', changes.patientEmail);
    if (changes.patientPhone !== undefined) set('patient_phone', changes.patientPhone);
    if (changes.appointmentDate !== undefined) set('appointment_date', changes.appointmentDate);
    if (changes.startTime !== undefined) set('start_time', changes.startTime);
    if (changes.endTime !== undefined) set('end_time', changes.endTime);
    if (changes.serviceId !== undefined) set('service_id', changes.serviceId);
    if (changes.reason !== undefined) set('reason', changes.reason);
    if (changes.notes !== undefined) set('notes', changes.notes);

    if (changes.status !== undefined) {
      set('status', changes.status);
      // Keep the terminal timestamps consistent with the new status. The
      // database enforces this pairing, so getting it wrong here would surface
      // as a CHECK violation rather than silently bad data.
      set('cancelled_at', changes.status === 'CANCELLED' ? new Date() : null);
      set('completed_at', changes.status === 'COMPLETED' ? new Date() : null);
    }

    if (assignments.length === 0) return this.findById(id, client);

    values.push(id);
    const rows = await run<AppointmentRow>(
      client,
      `WITH updated AS (
         UPDATE appointments SET ${assignments.join(', ')}
         WHERE id = $${values.length}
         RETURNING *
       )
       SELECT ${SELECT_COLUMNS}
       FROM updated a LEFT JOIN services s ON s.id = a.service_id`,
      values,
    );
    return rows[0] ? toAppointment(rows[0]) : null;
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await query('DELETE FROM appointments WHERE id = $1', [id]);
    return rowCount > 0;
  },

  /**
   * Filtered, paginated listing — backs both the admin table and a patient's
   * own list.
   *
   * `COUNT(*) OVER()` returns the unpaginated total in the same round trip,
   * avoiding a second query whose result could disagree with the page.
   */
  async findMany(
    filters: AppointmentFilters,
  ): Promise<{ items: Appointment[]; total: number; page: number; pageSize: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    const where = (clause: string, value: unknown) => {
      values.push(value);
      conditions.push(clause.replace('$?', `$${values.length}`));
    };

    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      where('a.status = ANY($?::appointment_status[])', statuses);
    }
    if (filters.userId) where('a.user_id = $?', filters.userId);
    if (filters.email) where('lower(a.patient_email) = lower($?)', filters.email);

    // Ownership: linked to the account, or booked as a guest with the same
    // email before the account existed.
    if (filters.owner) {
      values.push(filters.owner.userId, filters.owner.email);
      conditions.push(
        `(a.user_id = $${values.length - 1} OR lower(a.patient_email) = lower($${values.length}))`,
      );
    }
    if (filters.date) where('a.appointment_date = $?', filters.date);
    if (filters.from) where('a.appointment_date >= $?', filters.from);
    if (filters.to) where('a.appointment_date <= $?', filters.to);

    // Scope filters resolve "today" on the server against the clinic's
    // timezone, so a client cannot shift the boundary by sending its own clock.
    if (filters.scope === 'today') where('a.appointment_date = $?::date', clinicToday());
    if (filters.scope === 'upcoming') where('a.appointment_date >= $?::date', clinicToday());
    if (filters.scope === 'past') where('a.appointment_date < $?::date', clinicToday());

    if (filters.search) {
      // One bound parameter reused across three columns; matches the trigram
      // index on (patient_name || patient_email || reason).
      values.push(filters.search);
      const placeholder = `$${values.length}`;
      conditions.push(
        `(a.patient_name ILIKE '%' || ${placeholder} || '%'
          OR a.patient_email ILIKE '%' || ${placeholder} || '%'
          OR a.reason ILIKE '%' || ${placeholder} || '%')`,
      );
    }

    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 20));

    const orderBy =
      filters.sort === 'date_desc'
        ? 'a.appointment_date DESC, a.start_time DESC'
        : filters.sort === 'created_desc'
          ? 'a.created_at DESC'
          : 'a.appointment_date ASC, a.start_time ASC';

    values.push(pageSize, (page - 1) * pageSize);

    const { rows } = await query<AppointmentRow & { total_count: string }>(
      `SELECT ${SELECT_COLUMNS}, COUNT(*) OVER() AS total_count
       ${FROM_CLAUSE}
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY ${orderBy}
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return {
      items: rows.map(toAppointment),
      total: rows[0] ? Number(rows[0].total_count) : 0,
      page,
      pageSize,
    };
  },

  /**
   * Dashboard counters.
   *
   * A single pass with FILTER aggregates rather than five separate COUNT
   * queries — one round trip, one scan, and the numbers are guaranteed to be
   * consistent with each other.
   *
   * "Today" and "now" are passed in from the clinic's timezone rather than
   * using `CURRENT_DATE`/`LOCALTIME`, which would resolve against whatever
   * timezone the database server happens to run in.
   */
  async getStats(): Promise<AppointmentStats> {
    const { date: today, time: now } = clinicNow();
    const row = await queryOne<{
      today: string;
      upcoming: string;
      completed: string;
      cancelled: string;
      total: string;
      today_remaining: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE appointment_date = $1::date AND status <> 'CANCELLED')  AS today,
         COUNT(*) FILTER (WHERE appointment_date >= $1::date AND status = 'BOOKED')     AS upcoming,
         COUNT(*) FILTER (WHERE status = 'COMPLETED')                                   AS completed,
         COUNT(*) FILTER (WHERE status = 'CANCELLED')                                   AS cancelled,
         COUNT(*)                                                                       AS total,
         COUNT(*) FILTER (WHERE appointment_date = $1::date
                            AND status = 'BOOKED'
                            AND start_time >= $2::time)                                 AS today_remaining
       FROM appointments`,
      [today, now],
    );

    return {
      today: Number(row?.today ?? 0),
      upcoming: Number(row?.upcoming ?? 0),
      completed: Number(row?.completed ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
      total: Number(row?.total ?? 0),
      todayRemaining: Number(row?.today_remaining ?? 0),
    };
  },

  /**
   * Links previously-made guest bookings to a newly created account.
   *
   * Called after registration: someone who booked as a guest and then signs up
   * with the same address should find their appointment waiting in
   * "My appointments" rather than appearing to have lost it.
   */
  async claimGuestAppointments(userId: string, email: string): Promise<number> {
    const { rowCount } = await query(
      `UPDATE appointments
       SET user_id = $1
       WHERE user_id IS NULL AND lower(patient_email) = lower($2)`,
      [userId, email],
    );
    return rowCount;
  },
};
