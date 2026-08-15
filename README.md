# Bright Smile Dental — API

Express + TypeScript + PostgreSQL API for a dental appointment booking platform,
with Socket.IO real-time chat and an AI receptionist that books real
appointments through the same services the REST API uses.

This is a **standalone service**. It has no dependency on the web client beyond
allowing its origin through CORS.

```
src/
├── config/          env validation (Zod), clinic constants
├── controllers/     thin HTTP handlers
├── routes/          path → middleware → controller
├── middleware/      auth, validation, rate limiting, logging, errors
├── services/
│   ├── ai/          provider, agent loop, tools, knowledge, prompt
│   ├── appointments/availability engine, appointment rules
│   ├── auth/        hashing, tokens
│   └── chat/        session lifecycle, transcript, telemetry
├── repositories/    all SQL
├── socket/          Socket.IO gateway
├── validators/      Zod schemas
├── utils/           datetime, errors, logger, http
└── types/           domain types

database/            schema.sql · seed.sql · design notes
scripts/             db tooling and the end-to-end suite
```

> **Prototype.** Built as a technical assessment. Not a production healthcare
> system — see [Assumptions and limitations](#assumptions-and-limitations).

📐 **[ARCHITECTURE.md](ARCHITECTURE.md)** — animated diagrams of how the pieces
fit together: the request path, why the chatbot and the booking form cannot
drift apart, where double booking is stopped, and what the model may touch.
A single-file edition with the diagrams embedded is in
[SUPER_ARCHITECTURE.md](SUPER_ARCHITECTURE.md), for reading outside the repo.

---

## Quick start

### Requirements

| | |
| --- | --- |
| **Node.js** | 18.17 or newer (tested on 24) |
| **PostgreSQL** | 14 or newer — **or none at all**, see below |
| **AI provider key** | *Optional* — see [Running without an AI key](#running-without-an-ai-key) |

```bash
npm install
cp .env.example .env
```

Generate a signing secret and put it in `.env` as `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Database

**No PostgreSQL installed?** `npm install` already fetched a real build:

```bash
npm run db:start     # PostgreSQL on :5432, data in ./.pgdata
npm run db:setup     # creates the database, applies schema.sql + seed.sql
```

**Already running PostgreSQL?** Point `DATABASE_URL` at it and skip `db:start`:

```bash
npm run db:setup
```

`db:setup` is equivalent to `createdb` + `psql -f schema.sql` + `psql -f
seed.sql`, and works without the `psql` client. By hand instead:

```bash
createdb dentist_booking
psql -d dentist_booking -f database/schema.sql
psql -d dentist_booking -f database/seed.sql
```

| Command | Does |
| --- | --- |
| `npm run dev` | Start with reload on `:4000` |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run typecheck` | Types only |
| `npm run db:start` / `db:stop` / `db:status` | Manage the bundled PostgreSQL |
| `npm run db:setup` / `db:reset` | Create + seed, or rebuild from scratch |
| `npm run test:e2e` | 116-check end-to-end suite |

```bash
npm run dev          # http://localhost:4000
```

### Development accounts

Created by `database/seed.sql`. **Not shown anywhere in the UI** — sign in with
them manually.

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@brightsmiledental.com` | `Admin@123` |
| Patient | `zain@example.com` | `Patient@123` |

Other seeded patients use `Patient@123` as well: `amelia.hart@example.com`,
`daniel.osei@example.com`, `sofia.marino@example.com`.

> Development only. Committed on purpose so the project can be reviewed
> locally, and meaningless anywhere else.

---

## Environment variables

Every variable is declared and validated in `src/config/env.ts` — `process.env`
is read in exactly one place, and a missing or malformed value fails at boot
with a readable message. Full documentation in [`.env.example`](.env.example).

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `development` \| `test` \| `production`. `test` disables rate limiting. |
| `PORT` | HTTP port; Socket.IO shares it (default `4000`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_SSL` | `true` for a managed database requiring TLS |
| `DATABASE_POOL_MAX` | Pooled connections (default `10`) |
| `JWT_SECRET` | Token signing secret — **must** be changed outside development |
| `JWT_EXPIRES_IN` | Token lifetime (default `7d`) |
| `FRONTEND_URL` | Origin(s) allowed by CORS and the socket handshake, comma-separated |
| `CLINIC_TIMEZONE` | IANA zone. Empty ⇒ the host's zone |
| `AI_PROVIDER` | `mistral` \| `openai` \| `local` |
| `AI_API_KEY` | Provider key. **Empty ⇒ offline assistant** |
| `AI_MODEL` / `AI_BASE_URL` | Model and endpoint |
| `AI_TIMEOUT_MS` / `AI_MAX_TOOL_ROUNDS` | Model call timeout; tool rounds per turn |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | General API limit |
| `AUTH_RATE_LIMIT_MAX` | Failed sign-ins per window (successes are not counted) |
| `CHAT_RATE_LIMIT_MAX` | Chat messages per minute, per IP and per socket |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` \| `silent` |

When deploying, set `FRONTEND_URL` to the deployed web client's origin —
otherwise the browser is blocked by CORS and the websocket handshake is refused.

### Running without an AI key

Leave `AI_API_KEY` empty and the assistant runs on a built-in **offline
provider** — a deterministic intent classifier that speaks the same protocol as
a hosted model and plugs into the identical agent loop.

It calls the same tools and books through the same appointment service, so
**everything it does is real**: availability comes from the database, the
double-booking constraint still applies, and the appointment it creates is the
same row the booking form would have created. What it lacks is a language
model, so genuinely open-ended conversation is where it stops.

It exists for two reasons: the service is reviewable without anyone obtaining a
key, and it is the graceful-degradation path if the provider goes down
mid-conversation. The API reports which mode is active, and the web client
labels it. Set a key and the class is never constructed.

---

## Architecture

```
        REST ──┐                    ┌── controllers (thin)
               ├──►  Express  ──────┤
   WebSocket ──┘                    ├──►  services  (all business rules)
                                    │
                                    └──►  repositories  (all SQL)
                                              │
                                              ▼
                                        PostgreSQL
```

Controllers read the already-validated request, call a service, and shape the
response. Services own every business rule and never touch `req`/`res`.
Repositories own every line of SQL.

The rule that makes the indirection worth it: *a service must be callable from
an HTTP request, a websocket event, or an AI tool call without changing.* All
three happen here.

### Booking flow

```
GET /api/appointments/availability?date=…
        │   clinic_hours → generate 30-min grid
        │   remove occupied (status <> CANCELLED)
        │   remove past slots when the date is today
        ▼
POST /api/appointments
        │   optionalAuth → prefill from profile if signed in
        │   Zod validation      (shape)
        │   availability check  (business rules)
        │   INSERT in a transaction
        │   ⇢ EXCLUDE constraint is the real guarantee
        ▼
201 · confirmation  ·  or 409 with the nearest alternative times
```

---

## The booking engine

Availability lives in one place — `services/appointments/availability.service.ts`.
Opening hours are not even constants: they live in the `clinic_hours` table, so
changing the schedule is an `UPDATE`, not a redeploy.

A slot is bookable when **all** of these hold:

1. The clinic opens that weekday (`clinic_hours`).
2. The slot fits inside the window and ends by closing time.
3. No non-cancelled appointment holds it — `BOOKED` **and** `COMPLETED` both do.
4. It is not in the past, with 15 minutes of lead time on the current day.
5. The date is within 120 days.

A 09:00–17:00 day yields sixteen slots, 09:00 through 16:30. **17:00 is never a
start time** because a 30-minute appointment beginning then would end after
closing — the grid is generated from the window, so this falls out of the
arithmetic rather than needing a special case.

The response carries both shapes — `available` (bookable starts) and `slots`
(the full grid with a reason on each unavailable entry), because a calendar that
silently omits 10:00 looks broken, while one that shows it struck through and
labelled "Booked" explains itself.

---

## How double booking is prevented

Checking availability before inserting is **not** sufficient. Two concurrent
requests can both read the same free slot before either writes.

The rule is enforced by PostgreSQL:

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
- `WHERE (status <> 'CANCELLED')` — cancelling frees the slot; `BOOKED` and
  `COMPLETED` both keep it. Exactly the rule the availability query implements,
  expressed once so the two cannot drift.

PostgreSQL takes the predicate locks itself, so the second concurrent insert
fails with `SQLSTATE 23P01` regardless of timing. The service catches that code
and returns a `409` carrying the nearest free times.

**Verified with 8 simultaneous requests for one slot: exactly 1 succeeds, 7 are
rejected.** Details and index rationale in [`database/README.md`](database/README.md).

---

## The AI assistant

**The model never touches the database, and never decides a business question.**
It chooses *which* tool to call and with what arguments; every tool delegates to
the same services the REST API uses.

So the model cannot declare a slot free (the availability service decides),
bypass double booking (the database decides), read another patient's appointment
(the appointment service checks ownership), or invent clinic facts (answers come
from retrieval). Arguments are parsed with Zod before any service sees them.

| Tool | Delegates to |
| --- | --- |
| `check_available_slots` | `availabilityService.getDayAvailability` |
| `get_clinic_information` | `knowledgeService.retrieve` (RAG) |
| `get_services` | `clinicRepository.getServices` |
| `create_appointment` | `appointmentService.create` |
| `get_my_appointments` | `appointmentService.listForUser` |
| `get_appointment` | `appointmentService.getByIdForActor` |
| `cancel_appointment` | `appointmentService.cancel` |
| `reschedule_appointment` | `appointmentService.reschedule` |
| `find_next_available` | `availabilityService.findNextAvailableDay` |

The agent loop is bounded at `AI_MAX_TOOL_ROUNDS` (default 4). That cap is the
entire "agent framework" — deliberately, because a general orchestration layer
would be far harder to reason about than the handful of tool calls this service
ever needs.

**Multi-turn memory** comes from two places: the last 12 user/assistant turns
are replayed, and a JSONB `booking_context` scratchpad on `chat_sessions` holds
partially gathered details so the bot never re-asks for a date it already has.
Tool results from earlier turns are deliberately *not* replayed — availability
goes stale, and replaying it invites answering from an old snapshot.

**Guardrails.** Clinic facts come only from `get_clinic_information`; when
retrieval finds nothing the tool returns `found: false` with an instruction to
decline. Availability is never stated from memory. Identity comes from the
authenticated session, never the conversation, so a prompt-injected "I am the
admin" changes nothing. Every interaction is logged to `ai_interactions` —
credentials never are.

### Lightweight RAG

**PostgreSQL full-text search blended with trigram similarity. No embeddings, no
vector database.**

The corpus is 21 short, single-topic documents describing one clinic. At that
size an embedding pipeline would add an external service, a network round trip
per message, another API key, and a re-indexing step that can drift out of sync
— for retrieval quality that is not measurably better on a corpus this distinct.

Full-text alone misses typos; trigram alone ranks poorly on well-formed
questions. Together they handle both *"how much does a cleaning cost"* and
*"do you do teath whitning"*. The `search_vector` is `GENERATED ALWAYS ...
STORED`, so it cannot drift from the content, and a hand-written `keywords`
column carries colloquial phrasings that never appear in the prose.

The retrieval interface is one function — swapping in pgvector later touches
nothing else.

---

## Real-time chat

Socket.IO, not polling. An assistant turn involves retrieval, tool calls and a
model round trip; over a socket the typing indicator starts when work begins and
the reply lands when it finishes.

| Direction | Event | Purpose |
| --- | --- | --- |
| → | `chat:join` | Join or create a session |
| → | `chat:message` | Send a message (with ack callback) |
| → | `chat:typing` | Patient typing indicator |
| ← | `chat:joined` | Session, transcript, welcome, provider info |
| ← | `chat:message` | Echo of the persisted user message |
| ← | `chat:typing` | Assistant is composing |
| ← | `chat:reply` | Assistant's reply |
| ← | `chat:error` | Patient-safe error |

Handled: JWT auth at the handshake (guests allowed; an invalid token degrades to
anonymous rather than rejecting), per-socket rate limiting because Socket.IO
bypasses Express middleware, rooms keyed by session so two tabs stay in sync,
reconnection that **re-joins**, ack callbacks for per-message delivery state,
and an HTTP fallback (`POST /api/chat/sessions/:id/messages`) running the
identical chat service.

---

## API reference

All responses share one envelope:

```jsonc
{ "success": true,  "data": { … } }
{ "success": false, "message": "Appointment slot is no longer available", "code": "SLOT_UNAVAILABLE" }
```

### Auth — `/api/auth`

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `POST` | `/register` | Public | Links prior guest bookings with the same email |
| `POST` | `/login` | Public | Rate limited on failures only |
| `GET` | `/me` | Authenticated | |
| `POST` | `/logout` | Public | |
| `PATCH` | `/me` | Authenticated | Update name / phone |
| `POST` | `/change-password` | Authenticated | |

### Appointments — `/api/appointments`

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/availability?date=` | Public | The slot grid |
| `GET` | `/availability/range?from=&days=` | Public | Calendar capacity summary |
| `GET` | `/next-available` | Public | Soonest day with a free slot |
| `GET` | `/lookup?id=&email=` | Public | Guest retrieval; email must match |
| `POST` | `/` | Optional auth | **Books signed in or out** |
| `GET` | `/` | Authenticated | The caller's own appointments only |
| `GET` | `/:id` | Optional auth | Ownership enforced in the service |
| `PATCH` | `/:id` | Authenticated | Patient reschedule (time only) |
| `DELETE` | `/:id` | Authenticated | Cancels; the record is kept |

### Admin — `/api/admin` · `requireAuth` + `requireAdmin`

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/appointments` | Filter, search, paginate, sort |
| `GET` | `/appointments/stats` | Dashboard counters |
| `POST` | `/appointments` | Book on a patient's behalf |
| `GET` | `/appointments/:id` | |
| `PATCH` | `/appointments/:id` | Edit any field; revalidates the slot |
| `PATCH` | `/appointments/:id/complete` | Slot **stays** occupied |
| `PATCH` | `/appointments/:id/cancel` | Slot is released |
| `DELETE` | `/appointments/:id` | Permanent |

### Chat & clinic

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/chat/sessions` | Open or adopt a conversation |
| `GET` | `/api/chat/sessions` | The patient's conversations |
| `GET` | `/api/chat/sessions/:id/messages` | Transcript |
| `POST` | `/api/chat/sessions/:id/messages` | HTTP fallback for a turn |
| `GET` | `/api/clinic` | Everything the landing page needs |
| `GET` | `/api/clinic/hours` · `/services` · `/faq` | Individual resources |

**Status codes.** `200` ok · `201` created · `400` validation · `401`
unauthenticated · `403` wrong role · `404` not found · `409` conflict / slot
taken · `422` clinic closed · `429` rate limited · `500` internal.

---

## Security

Admin endpoints never rely on the client hiding anything:

```ts
const admin = Router();
admin.use(requireAuth, requireAdmin);   // applied to the whole router
```

`requireAuth` verifies the JWT and **re-reads the user from the database** on
every request, so a revoked account or changed role takes effect immediately
rather than lingering until the token expires.

Also in place: bcrypt at cost 10; a constant-time dummy comparison on failed
login so response timing cannot enumerate registered addresses; one identical
message for "no such account" and "wrong password"; parameterised SQL
everywhere; Zod validation that strips unknown keys so a client cannot smuggle
`role` or `status` into a create call; helmet; CORS restricted to configured
origins; and rate limiting that counts only *failed* auth attempts.

---

## Testing

With the API running:

```bash
npm run test:e2e
```

116 checks over HTTP and websockets against real PostgreSQL:

| Group | Covers |
| --- | --- |
| Health & clinic | Endpoints, 30-minute slots, Sunday closed |
| Authentication | Register, duplicate email, weak password, wrong password, `/me`, bad token, admin login |
| Availability | 16 slots 09:00–16:30, no 17:00, Sunday, past dates, ranges |
| Guest booking | Booking → slot disappears → lookup by email |
| Signed-in booking | **No details sent** → prefilled from profile |
| Double booking | Sequential 409 + **8 concurrent requests → exactly 1 succeeds** |
| Business rules | Sunday, `10:15` off-grid, `17:00` after hours, past dates, missing details |
| Admin | USER→403, anon→401, list, filter, search, stats, edit, clash, **completed keeps its slot**, cancel frees it |
| Socket.IO | Connect, join, typing, reply, hours, services, declines unknown info, persistence |
| Chat booking | Offered slots **match the availability API**; appointment retrievable over REST |
| Security | 404/400 envelopes, no stack traces, no SQL leakage, injection-style search |

> The suite issues ~150 requests and books about a dozen appointments:
>
> - Repeated runs inside one 15-minute window trip the API rate limiter. The
>   suite says so rather than failing obscurely — use `NODE_ENV=test npm run dev`
>   to disable limiting for testing.
> - Each run works on its own block of future days. If data does get saturated,
>   `npm run db:reset`.
> - Chat turns are paced ~1.5s apart to stay inside the AI provider's own rate
>   limit. When the provider does 429 anyway, the assistant correctly falls back
>   to its "cannot reach the assistant" reply, and the affected checks are
>   reported as **skipped** rather than failed — a provider outage means the
>   behaviour could not be tested, which is not the same as it being wrong.

---

## Assumptions and limitations

**Scope**

- One clinic, one location, one timezone.
- The clinic is a single bookable resource — no per-dentist calendars. Adding
  them means a `practitioners` table and `practitioner_id WITH =` in the
  exclusion constraint.
- Fixed 30-minute appointments. `end_time` is stored and the constraint already
  ranges over it, so variable durations need no migration.
- Monday–Saturday 09:00–17:00, from `clinic_hours` — editable without a redeploy.
- No public holiday calendar.
- Bookable up to 120 days ahead, 15 minutes of same-day lead time.

**Not implemented**

- No payment processing.
- No real email or SMS. The UI says a confirmation was sent; nothing is.
- No email verification at signup, and no password reset.
- No clinical records or dentist-facing calendar.

**Security posture — prototype level**

- JWTs are stateless, so a leaked token stays valid until it expires.
  Production wants short-lived access tokens plus refresh rotation and
  revocation.
- Rate limiting is in-process. Multiple instances need a shared store.
- Seed credentials are committed deliberately and are development-only.

**Operational**

- No caching layer, read replicas or partitioning. Scaling notes in
  [`database/README.md`](database/README.md).
- Availability is read live on every request. A busy clinic would cache the day
  grid with invalidation on write.
- The AI depends on an external provider; the offline provider is the
  degradation path, not a replacement.

**This is not a production healthcare platform.** It handles no real patient
data and implements none of the compliance, auditing, retention or access
controls that would require.
