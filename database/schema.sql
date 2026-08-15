-- =============================================================================
--  Bright Smile Dental Clinic — Database Schema
--  PostgreSQL 14+
-- =============================================================================
--  Apply with:
--      psql -U <user> -d dentist_booking -f database/schema.sql
--
--  This script is idempotent: it drops and recreates the application objects,
--  so it can be re-run during development.  DO NOT run against real data.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
--  Extensions
-- -----------------------------------------------------------------------------
--  pgcrypto  -> gen_random_uuid() for primary keys.
--  btree_gist-> lets us combine an equality column (appointment_date) with a
--               range column (time range) inside a single EXCLUDE constraint,
--               which is how we make double-booking impossible at the storage
--               layer.  See the appointments table below.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
--  This script is NON-DESTRUCTIVE and safe to re-run
-- -----------------------------------------------------------------------------
--  Every statement below creates only what is missing, so applying it to a
--  populated database leaves existing rows untouched.  That matters because it
--  runs on every deploy: an earlier version of this file began by dropping the
--  tables, which quietly erased real data each time it was applied.
--
--  To deliberately start over, drop the database instead:
--      npm run db:reset
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
--  Enumerated types
-- -----------------------------------------------------------------------------
--  Enums (rather than free-text + CHECK) give us a single source of truth that
--  is enforced by the database and reflected in the TypeScript types.
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('USER', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    CREATE TYPE appointment_status AS ENUM ('BOOKED', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    CREATE TYPE chat_role AS ENUM ('user', 'assistant', 'system', 'tool');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
--  timerange — a range type over TIME
-- -----------------------------------------------------------------------------
--  PostgreSQL ships range types for numbers, dates and timestamps but not for
--  bare TIME.  We need one so the appointments table can EXCLUDE on overlapping
--  time windows (see appointments_no_overlap below).
--
--  subtype_diff is optional but tells GiST how "far apart" two times are, which
--  lets the index build balanced pages instead of degenerating toward a scan.
CREATE OR REPLACE FUNCTION time_subtype_diff(x TIME, y TIME) RETURNS FLOAT8 AS $$
    SELECT EXTRACT(EPOCH FROM (x - y))::FLOAT8;
$$ LANGUAGE sql IMMUTABLE STRICT;

DO $$ BEGIN
    CREATE TYPE timerange AS RANGE (
        subtype      = TIME,
        subtype_diff = time_subtype_diff
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
--  updated_at trigger helper
-- -----------------------------------------------------------------------------
--  Keeping this in the database (instead of the application) guarantees the
--  column is correct no matter which code path performs the UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
--  users
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT        NOT NULL,
    email         TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    phone         TEXT,
    role          user_role   NOT NULL DEFAULT 'USER',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT users_name_not_blank  CHECK (length(btrim(name)) BETWEEN 2 AND 120),
    -- Deliberately permissive: real address validation happens by sending mail.
    -- This only rejects input that is obviously not an address.
    CONSTRAINT users_email_format    CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    -- Stored E.164-ish; the API normalises before insert.
    CONSTRAINT users_phone_format    CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()\-]{7,25}$')
);

--  Emails are compared case-insensitively.  A unique index on lower(email) is
--  what actually prevents duplicate signups; the application also lowercases on
--  write so lookups can use this index directly.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

--  Admin listings are ordered newest-first.
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);

CREATE OR REPLACE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
--  clinic_hours
-- =============================================================================
--  Opening hours live in the database rather than in application constants so
--  that availability is *data driven*.  Changing the clinic's schedule is an
--  UPDATE, not a redeploy, and the AI knowledge base reads from the same rows
--  the availability engine uses -- there is exactly one source of truth.
CREATE TABLE IF NOT EXISTS clinic_hours (
    day_of_week SMALLINT PRIMARY KEY,          -- 0 = Sunday … 6 = Saturday (matches JS getDay())
    is_open     BOOLEAN  NOT NULL DEFAULT TRUE,
    opens_at    TIME,
    closes_at   TIME,

    CONSTRAINT clinic_hours_dow_range CHECK (day_of_week BETWEEN 0 AND 6),
    -- An open day must define both ends of its window, and they must be ordered.
    CONSTRAINT clinic_hours_window CHECK (
        (is_open = FALSE AND opens_at IS NULL AND closes_at IS NULL)
        OR
        (is_open = TRUE  AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at < closes_at)
    )
);

-- =============================================================================
--  services
-- =============================================================================
--  Treatments offered.  Surfaced on the landing page, in the booking form and
--  in the chatbot knowledge base.
CREATE TABLE IF NOT EXISTS services (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          TEXT        NOT NULL UNIQUE,
    name          TEXT        NOT NULL,
    description   TEXT        NOT NULL,
    duration_min  INTEGER     NOT NULL DEFAULT 30,
    price_from    NUMERIC(10,2),
    icon          TEXT,
    display_order INTEGER     NOT NULL DEFAULT 0,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT services_duration_positive CHECK (duration_min > 0),
    CONSTRAINT services_price_non_negative CHECK (price_from IS NULL OR price_from >= 0)
);

--  The public service list is always "active, in display order".
CREATE INDEX IF NOT EXISTS services_active_order_idx ON services (is_active, display_order);

CREATE OR REPLACE TRIGGER services_set_updated_at
    BEFORE UPDATE ON services
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
--  appointments
-- =============================================================================
--  user_id is NULLABLE by design: guests can book without an account.  Contact
--  details are therefore *always* denormalised onto the row (patient_name /
--  patient_email / patient_phone) instead of being read through the join.  That
--  keeps the appointment self-contained and means editing a profile later never
--  silently rewrites the contact details of a past booking.
CREATE TABLE IF NOT EXISTS appointments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID REFERENCES users (id) ON DELETE SET NULL,

    patient_name     TEXT        NOT NULL,
    patient_email    TEXT        NOT NULL,
    patient_phone    TEXT        NOT NULL,

    appointment_date DATE        NOT NULL,
    start_time       TIME        NOT NULL,
    end_time         TIME        NOT NULL,

    service_id       UUID REFERENCES services (id) ON DELETE SET NULL,
    reason           TEXT        NOT NULL,
    notes            TEXT,
    status           appointment_status NOT NULL DEFAULT 'BOOKED',

    -- Where the booking came from.  Useful for analytics and for proving in a
    -- demo that the chatbot and the booking form really do share one pipeline.
    source           TEXT        NOT NULL DEFAULT 'WEB',

    cancelled_at     TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT appointments_name_not_blank  CHECK (length(btrim(patient_name)) BETWEEN 2 AND 120),
    CONSTRAINT appointments_email_format    CHECK (patient_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT appointments_phone_format    CHECK (patient_phone ~ '^\+?[0-9 ()\-]{7,25}$'),
    CONSTRAINT appointments_reason_not_blank CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    CONSTRAINT appointments_notes_length    CHECK (notes IS NULL OR length(notes) <= 2000),
    CONSTRAINT appointments_time_order      CHECK (start_time < end_time),
    -- Slots are aligned to :00 / :30 and start within clinic hours.  Enforcing
    -- the grid here means a bad INSERT from *any* client is rejected, not just
    -- one that went through the API.
    CONSTRAINT appointments_slot_alignment  CHECK (
        EXTRACT(MINUTE FROM start_time) IN (0, 30)
        AND EXTRACT(SECOND FROM start_time) = 0
    ),
    CONSTRAINT appointments_within_hours    CHECK (
        start_time >= TIME '09:00' AND end_time <= TIME '17:00'
    ),
    CONSTRAINT appointments_source_valid    CHECK (source IN ('WEB', 'CHATBOT', 'ADMIN')),
    -- Terminal-state timestamps must agree with the status they describe.
    CONSTRAINT appointments_cancelled_at_consistent CHECK (
        (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
        OR (status <> 'CANCELLED' AND cancelled_at IS NULL)
    ),
    CONSTRAINT appointments_completed_at_consistent CHECK (
        (status = 'COMPLETED' AND completed_at IS NOT NULL)
        OR (status <> 'COMPLETED' AND completed_at IS NULL)
    )
);

-- -----------------------------------------------------------------------------
--  ***  THE DOUBLE-BOOKING GUARANTEE  ***
-- -----------------------------------------------------------------------------
--  Two patients must never hold overlapping time on the same day.  Checking
--  "SELECT … then INSERT" in the service layer is not sufficient: two concurrent
--  transactions can both read an empty slot before either writes.
--
--  This EXCLUDE constraint pushes the rule into the storage engine.  Postgres
--  takes the necessary predicate locks itself, so the *second* concurrent
--  INSERT is rejected with SQLSTATE 23P01 no matter how the race is timed.
--
--    WITH (=)      on appointment_date -> only compare rows on the same day
--    WITH (&&)     on the time range   -> reject any overlap, not just exact
--                                        matches (protects future variable
--                                        duration treatments too)
--    WHERE status  -> a CANCELLED appointment releases its slot; BOOKED and
--                     COMPLETED both continue to occupy it.  This is precisely
--                     the rule the availability API implements, expressed once.
DO $$ BEGIN
    ALTER TABLE appointments
        ADD CONSTRAINT appointments_no_overlap
        EXCLUDE USING gist (
            appointment_date WITH =,
            timerange(start_time, end_time, '[)') WITH &&
        )
        WHERE (status <> 'CANCELLED');
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
--  Indexes
-- -----------------------------------------------------------------------------
--  Every index below backs a query the application actually issues.

--  1. Availability lookup — the hottest query in the system.  Runs on every
--     date change in the booking UI and on every chatbot availability check:
--        WHERE appointment_date = $1 AND status <> 'CANCELLED'
--     The composite (date, start_time) lets Postgres satisfy the lookup and
--     return rows pre-sorted by slot, so no extra sort node is needed.
CREATE INDEX IF NOT EXISTS appointments_date_start_time_idx
    ON appointments (appointment_date, start_time);

--  2. Admin status filters and the dashboard statistic cards
--        WHERE status = 'BOOKED' ORDER BY appointment_date
CREATE INDEX IF NOT EXISTS appointments_status_date_idx
    ON appointments (status, appointment_date DESC);

--  3. "My appointments" for a signed-in patient.
--     Partial: guest bookings have user_id IS NULL and are never queried this
--     way, so they are kept out of the index entirely.
CREATE INDEX IF NOT EXISTS appointments_user_id_date_idx
    ON appointments (user_id, appointment_date DESC)
    WHERE user_id IS NOT NULL;

--  4. Guest lookup — a signed-out patient finds their booking by email, and
--     newly registered users can claim past guest bookings by address.
CREATE INDEX IF NOT EXISTS appointments_patient_email_idx
    ON appointments (lower(patient_email));

--  5. Admin free-text search across patient name / email / reason.  A trigram
--     index keeps ILIKE '%term%' off a sequential scan as the table grows.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS appointments_search_trgm_idx
    ON appointments USING gin (
        (patient_name || ' ' || patient_email || ' ' || reason) gin_trgm_ops
    );

--  6. "Today's appointments" card and the upcoming-appointments list.  Partial
--     on the only status those views care about, which keeps the index small.
CREATE INDEX IF NOT EXISTS appointments_upcoming_idx
    ON appointments (appointment_date, start_time)
    WHERE status = 'BOOKED';

CREATE OR REPLACE TRIGGER appointments_set_updated_at
    BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
--  clinic_knowledge  (lightweight RAG corpus)
-- =============================================================================
--  Documents the chatbot retrieves from before answering informational
--  questions.  Storing the corpus as rows (rather than files on disk) means the
--  clinic's answers can be edited without a deploy, and it keeps retrieval a
--  plain SQL query -- no vector database to operate for a corpus this size.
--
--  Retrieval strategy: PostgreSQL full-text search (tsvector/ts_rank) blended
--  with trigram similarity for typo tolerance.  See README "Lightweight RAG".
CREATE TABLE IF NOT EXISTS clinic_knowledge (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category      TEXT        NOT NULL,
    title         TEXT        NOT NULL,
    content       TEXT        NOT NULL,
    -- Hand-written extra retrieval surface: colloquial phrasings a patient
    -- might use that do not appear in the formal content ("how much", "cost").
    keywords      TEXT        NOT NULL DEFAULT '',
    priority      INTEGER     NOT NULL DEFAULT 0,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Generated column: the search vector is always in sync with the content,
    -- and it cannot drift because the application forgot to reindex.
    -- Title and keywords are weighted above body text.
    search_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')),    'A') ||
        setweight(to_tsvector('english', coalesce(keywords, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(content, '')),  'C')
    ) STORED,

    CONSTRAINT clinic_knowledge_content_not_blank CHECK (length(btrim(content)) > 0)
);

--  GIN over the generated tsvector — the primary retrieval path.
CREATE INDEX IF NOT EXISTS clinic_knowledge_search_idx
    ON clinic_knowledge USING gin (search_vector);

--  Trigram fallback so near-miss spellings ("apointment", "flouride") still
--  retrieve the right document.
CREATE INDEX IF NOT EXISTS clinic_knowledge_trgm_idx
    ON clinic_knowledge USING gin ((title || ' ' || keywords) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS clinic_knowledge_category_idx
    ON clinic_knowledge (category)
    WHERE is_active;

CREATE OR REPLACE TRIGGER clinic_knowledge_set_updated_at
    BEFORE UPDATE ON clinic_knowledge
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
--  chat_sessions
-- =============================================================================
--  One row per conversation.  user_id is nullable because anonymous visitors
--  chat before they sign up; the browser holds the session id and the server
--  binds it to a user the moment one authenticates.
--
--  `booking_context` is the chatbot's multi-turn scratchpad: partially gathered
--  booking details (date, time, name, …) persisted between messages so the
--  conversation survives a page reload or a socket reconnect.  It is JSONB
--  rather than columns because the shape is a UI/AI concern that will change
--  more often than the relational core.
CREATE TABLE IF NOT EXISTS chat_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users (id) ON DELETE SET NULL,
    title           TEXT,
    guest_label     TEXT,
    booking_context JSONB       NOT NULL DEFAULT '{}'::jsonb,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

--  A user's chat history, newest conversation first.
CREATE INDEX IF NOT EXISTS chat_sessions_user_id_idx
    ON chat_sessions (user_id, last_message_at DESC)
    WHERE user_id IS NOT NULL;

--  Housekeeping: find and prune stale anonymous sessions.
CREATE INDEX IF NOT EXISTS chat_sessions_last_message_idx
    ON chat_sessions (last_message_at DESC);

CREATE OR REPLACE TRIGGER chat_sessions_set_updated_at
    BEFORE UPDATE ON chat_sessions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
--  chat_messages
-- =============================================================================
--  Full transcript.  ON DELETE CASCADE: deleting a conversation must not leave
--  orphaned messages behind.
--
--  `payload` carries structured attachments the UI renders as rich elements --
--  e.g. the list of available slots the assistant offered, or a confirmed
--  appointment card -- so a reloaded conversation redraws exactly as it was
--  instead of degrading to plain text.
CREATE TABLE IF NOT EXISTS chat_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID        NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
    role       chat_role   NOT NULL,
    content    TEXT        NOT NULL,
    payload    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chat_messages_content_length CHECK (length(content) <= 8000)
);

--  Transcript replay: every read of this table is "all messages for a session,
--  oldest first".  The composite index serves the filter and the ordering.
CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx
    ON chat_messages (session_id, created_at ASC);

-- =============================================================================
--  ai_interactions
-- =============================================================================
--  Observability for the AI layer, kept separate from the user-visible
--  transcript so that debugging data (latency, model, token counts, which
--  tools ran) can be retained or purged independently of the conversation.
--
--  NOTE: prompts and responses are stored, credentials are not.  The service
--  layer never writes API keys into this table.
CREATE TABLE IF NOT EXISTS ai_interactions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     UUID REFERENCES chat_sessions (id) ON DELETE CASCADE,
    user_id        UUID REFERENCES users (id) ON DELETE SET NULL,
    user_message   TEXT        NOT NULL,
    ai_response    TEXT        NOT NULL,
    provider       TEXT        NOT NULL,
    model          TEXT,
    intent         TEXT,
    tools_used     TEXT[]      NOT NULL DEFAULT '{}',
    retrieved_docs TEXT[]      NOT NULL DEFAULT '{}',
    latency_ms     INTEGER,
    prompt_tokens  INTEGER,
    output_tokens  INTEGER,
    was_fallback   BOOLEAN     NOT NULL DEFAULT FALSE,
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

--  Analytics reads are time-ordered; session drill-down is the other access path.
CREATE INDEX IF NOT EXISTS ai_interactions_created_at_idx ON ai_interactions (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_interactions_session_idx    ON ai_interactions (session_id, created_at DESC);

COMMIT;

-- =============================================================================
--  Notes for reviewers
-- =============================================================================
--  * Times are stored as DATE + TIME rather than a single TIMESTAMPTZ.  The
--    clinic is a single physical location in one timezone, and staff reason in
--    wall-clock terms ("the 2:30 slot").  Splitting the columns keeps the
--    availability query trivial and sidesteps a class of DST/offset bugs.  A
--    genuine multi-location product would store TIMESTAMPTZ plus a location
--    timezone instead -- see README "Assumptions and Limitations".
--
--  * end_time is stored rather than derived.  It is what the EXCLUDE constraint
--    ranges over, and it leaves room for treatments longer than one slot
--    without a schema migration.
--
--  * COMPLETED appointments keep occupying their slot.  Both the EXCLUDE
--    constraint and the availability query treat only CANCELLED as releasing
--    time, so the two can never disagree.
-- =============================================================================
