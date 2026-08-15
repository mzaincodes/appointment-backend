# Database — Bright Smile Dental Studio

PostgreSQL schema, seed data and the reasoning behind both.

| File | Purpose |
| --- | --- |
| `schema.sql` | Types, tables, constraints, indexes and triggers. Drops and recreates the application objects, so it is safe to re-run in development. |
| `seed.sql` | Development sample data: users, services, opening hours, the chatbot knowledge base, appointments, chat transcripts and AI logs. Idempotent. |

---

## Setup

Requires **PostgreSQL 14 or newer** (tested on 17.4 and 18.4). The schema uses
`pgcrypto`, `btree_gist` and `pg_trgm`, all of which ship with a standard
installation — creating extensions requires a superuser or a role with `CREATE`
on the database.

### The short way

From `backend/`, this does all three steps below and needs no `psql` client:

```bash
npm run db:start     # only if you have no PostgreSQL installed
npm run db:setup
```

### By hand

```bash
# 1. Create the database
createdb dentist_booking

# 2. Create the schema
psql -d dentist_booking -f database/schema.sql

# 3. Load development data
psql -d dentist_booking -f database/seed.sql
```

The last statement in `seed.sql` prints a row count per table so you can confirm
the load worked:

```
 table_name       | rows
------------------+------
 ai_interactions  |    2
 appointments     |   13
 chat_messages    |   10
 chat_sessions    |    2
 clinic_hours     |    7
 clinic_knowledge |   21
 services         |   10
 users            |    5
```

### Development credentials

> ⚠️ These accounts exist only in `seed.sql` and are committed to the repository
> on purpose so the project can be run and reviewed locally. They are
> **development-only** and must never be loaded anywhere holding real data.

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@brightsmiledental.com` | `Admin@123` |
| Patient | `zain@example.com` | `Patient@123` |
| Patient | `amelia.hart@example.com` | `Patient@123` |
| Patient | `daniel.osei@example.com` | `Patient@123` |
| Patient | `sofia.marino@example.com` | `Patient@123` |

Sample appointments are seeded relative to `CURRENT_DATE`, so there is always a
realistic spread of past, today and upcoming bookings whenever you load the file.

---

## Schema overview

```
users ──────────┬──< appointments >── services
                │
                ├──< chat_sessions ──< chat_messages
                │           │
                │           └────────< ai_interactions
                │
clinic_hours    clinic_knowledge
(availability)  (RAG corpus)
```

| Table | Role |
| --- | --- |
| `users` | Accounts and roles (`USER` / `ADMIN`). |
| `clinic_hours` | Opening window per weekday. **Drives availability** — not a hard-coded constant. |
| `services` | Treatments offered; shown on the site and in the knowledge base. |
| `appointments` | The bookings themselves. `user_id` is nullable so guests can book. |
| `clinic_knowledge` | Retrievable documents for the chatbot's knowledge base. |
| `chat_sessions` | One conversation, with a JSONB `booking_context` scratchpad. |
| `chat_messages` | The transcript; `payload` carries rich UI attachments. |
| `ai_interactions` | AI observability — latency, model, tools used, retrieved docs. |

---

## Design decisions

### Appointments store `DATE` + `TIME`, not `TIMESTAMPTZ`

The clinic is one physical location in one timezone, and staff reason in
wall-clock terms — "the 2:30 slot" means 2:30 on the wall no matter what the
server's locale is. Splitting the columns keeps the availability query trivial
and removes a class of offset bugs.

A genuine multi-location product would store `TIMESTAMPTZ` plus a per-location
timezone. That trade-off is recorded in the root README under *Assumptions and
Limitations*.

> One consequence worth knowing: `node-postgres` converts `DATE` columns into
> JavaScript `Date` objects in the server's local timezone, which shifts
> `2026-08-17` to `2026-08-16T19:00:00Z` in a UTC+5 shell. The backend disables
> that conversion in `src/db/pool.ts` and works with the raw strings.

### Contact details are denormalised onto each appointment

`patient_name`, `patient_email` and `patient_phone` are stored on the
appointment row even when `user_id` is set. Two reasons:

1. Guests book without an account, so there is no profile to read from.
2. Editing a profile later must not silently rewrite the contact details
   attached to a booking that already happened.

### `COMPLETED` still occupies its slot

Only `CANCELLED` releases time. This rule appears in exactly two places — the
exclusion constraint and the availability query — and both express it the same
way, so they cannot drift apart.

---

## How double booking is prevented

Checking availability in application code before inserting is **not** sufficient.
Two concurrent transactions can both read the same free slot before either
writes, and both then insert successfully.

The rule is therefore enforced by the storage engine:

```sql
ALTER TABLE appointments
    ADD CONSTRAINT appointments_no_overlap
    EXCLUDE USING gist (
        appointment_date WITH =,
        timerange(start_time, end_time, '[)') WITH &&
    )
    WHERE (status <> 'CANCELLED');
```

- `appointment_date WITH =` — only compare rows on the same day.
- `timerange(...) WITH &&` — reject any **overlap**, not just an exact match.
  This already covers treatments longer than one slot.
- `WHERE (status <> 'CANCELLED')` — a cancelled appointment frees its time;
  `BOOKED` and `COMPLETED` both continue to hold it.

PostgreSQL takes the predicate locks itself, so the second concurrent insert
fails with `SQLSTATE 23P01` regardless of timing. The service layer catches that
code and converts it into a `409 SLOT_UNAVAILABLE` response carrying nearby
alternative times.

`timerange` is not a built-in type — PostgreSQL ships range types for numbers,
dates and timestamps but not for bare `TIME` — so `schema.sql` defines one,
along with a `subtype_diff` function that lets GiST build balanced index pages.

### Verified behaviour

| Scenario | Result |
| --- | --- |
| Two inserts, identical slot | second rejected `23P01` |
| `14:00–15:00` against existing `14:30–15:00` | rejected (partial overlap) |
| `15:00–15:30` against existing `14:30–15:00` | accepted (adjacent, no overlap) |
| Same time, different date | accepted |
| Insert after the holder is `CANCELLED` | accepted (slot released) |
| Insert after the holder is `COMPLETED` | rejected (slot still held) |

Other invariants pushed into the database rather than trusted to the API:

- `appointments_slot_alignment` — starts land on `:00` or `:30`.
- `appointments_within_hours` — inside `09:00`–`17:00`.
- `appointments_time_order` — `start_time < end_time`.
- `appointments_cancelled_at_consistent` / `..._completed_at_consistent` —
  a status and its terminal timestamp can never disagree.

---

## Indexes and why they exist

Every index backs a query the application actually issues.

| Index | Query it serves |
| --- | --- |
| `appointments_date_start_time_idx` | **The hottest query.** Availability lookup: `WHERE appointment_date = $1 AND status <> 'CANCELLED'`. Composite `(date, start_time)` also returns rows pre-sorted by slot, removing a sort node. |
| `appointments_status_date_idx` | Admin status filters and the dashboard counters. |
| `appointments_user_id_date_idx` | "My appointments". Partial on `user_id IS NOT NULL` so guest rows stay out of it. |
| `appointments_patient_email_idx` | Guest lookup by email; also lets a new account claim earlier guest bookings. |
| `appointments_search_trgm_idx` | Admin free-text search. GIN trigram keeps `ILIKE '%term%'` off a sequential scan. |
| `appointments_upcoming_idx` | Today's / upcoming lists. Partial on `status = 'BOOKED'`, the only status those views read. |
| `users_email_lower_key` | Unique index on `lower(email)` — this is what actually prevents duplicate signups, and case-insensitive login uses it directly. |
| `clinic_knowledge_search_idx` | GIN over the generated `tsvector`; the primary RAG retrieval path. |
| `clinic_knowledge_trgm_idx` | Typo tolerance for near-miss spellings ("apointment", "flouride"). |
| `chat_messages_session_created_idx` | Transcript replay — every read is "all messages for a session, oldest first". |
| `ai_interactions_created_at_idx` | Time-ordered analytics reads. |

Partial indexes are used wherever a view only ever reads one status; they stay
smaller and are cheaper to maintain on write.

---

## The knowledge base as a table

`clinic_knowledge` holds the chatbot's retrieval corpus as rows rather than
files on disk. Two payoffs: clinic answers can be corrected with an `UPDATE`
instead of a deploy, and retrieval stays a plain SQL query.

The `search_vector` column is `GENERATED ALWAYS AS ... STORED`, so it can never
drift out of sync with the content — there is no reindex step to forget. Fields
are weighted `title` > `keywords` > `content`, and `keywords` deliberately
carries colloquial phrasings that never appear in the formal prose, which is
what lets "how much does it cost" retrieve a document titled *Payment, Pricing
& Insurance*.

Why full-text search rather than a vector database is argued in the root README
under *Lightweight RAG*.

---

## Notes on scale

The current schema comfortably handles a single clinic. Growing it into a
multi-tenant SaaS would mean:

1. **A `clinics` table**, with `clinic_id` on appointments, services, hours and
   knowledge. The exclusion constraint gains `clinic_id WITH =` so the
   double-booking guarantee becomes per-clinic automatically.
2. **A `practitioners` table.** Today the clinic is treated as one bookable
   resource; per-dentist calendars mean adding `practitioner_id WITH =` to the
   same constraint.
3. **Partitioning `appointments` by month** once the table reaches tens of
   millions of rows. Range partitioning on `appointment_date` matches how the
   data is queried — almost every read targets a narrow date window.
4. **Moving `TIME` to `TIMESTAMPTZ`** with a per-clinic timezone, once more than
   one timezone is in play.
5. **Archiving `chat_messages` and `ai_interactions`**, which grow fastest and
   have the shortest useful life.
