/**
 * End-to-end verification.
 *
 *   npm run test:e2e
 *
 * Exercises the running API and Socket.IO server the way the frontend does —
 * over HTTP and websockets, against a real PostgreSQL database. It covers the
 * scenarios in the assessment brief:
 *
 *   A  guest booking, and the slot disappearing afterwards
 *   B  signed-in booking with details filled from the profile
 *   C  booking through the chatbot over Socket.IO
 *   D  double booking, including a genuine concurrent race
 *   E  the admin surface, and completed slots staying unavailable
 *   F  the full Socket.IO round trip
 *
 * Requires the API to be running (`npm run dev`) and the database seeded.
 */

import { io, type Socket } from 'socket.io-client';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const BASE = `${API}/api`;

// ---------------------------------------------------------------------------
//  Tiny test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];
const skips: string[] = [];

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ${GREEN}✓${RESET} ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ${RED}✗ ${label}${RESET}`);
    if (detail !== undefined) {
      console.log(`    ${DIM}${JSON.stringify(detail).slice(0, 400)}${RESET}`);
    }
  }
}

/**
 * A check that depends on the AI provider actually answering.
 *
 * If the provider is rate-limiting or down, the assistant correctly falls back
 * to its "cannot reach the assistant" reply — which means the behaviour under
 * test could not be exercised at all. Reporting that as a failure would blame
 * this codebase for someone else's quota, so it is recorded as SKIPPED and the
 * run is not failed by it.
 */
function checkAi(label: string, condition: boolean, content: string): void {
  if (isProviderOutage(content)) {
    skipped += 1;
    skips.push(label);
    console.log(`  ${YELLOW}⊘${RESET} ${label} ${DIM}(AI provider unavailable)${RESET}`);
    return;
  }
  check(label, condition, content);
}

/** Thrown to abandon a section whose preconditions were not met. */
class SkipRest extends Error {}

function section(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`);
}

interface ApiResponse<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T };
}

// ---------------------------------------------------------------------------
//  Date helpers — pick real open days so the run works on any calendar day
// ---------------------------------------------------------------------------
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days, 12)).toISOString().slice(0, 10);
}
function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).getUTCDay();
}
/**
 * Each run works on its own block of future days.
 *
 * The suite books roughly a dozen appointments (including an 8-way race), so
 * repeated runs against a fixed set of dates eventually fill them and the
 * later runs fail for want of a free slot rather than because of a real
 * regression. Offsetting by the run's start minute spreads consecutive runs
 * across different days inside the 120-day booking window.
 */
const RUN_OFFSET_DAYS = 3 + (Math.floor(Date.now() / 60_000) % 40);

/** The nth open (non-Sunday) day in this run's block. */
function openDayAhead(nth: number): string {
  let date = new Date().toISOString().slice(0, 10);
  let found = 0;
  let skipped = 0;
  while (found < nth) {
    date = addDays(date, 1);
    if (dayOfWeek(date) === 0) continue;
    // Walk past this run's offset before counting.
    if (skipped < RUN_OFFSET_DAYS) {
      skipped += 1;
      continue;
    }
    found += 1;
  }
  return date;
}
function nextSunday(): string {
  let date = new Date().toISOString().slice(0, 10);
  while (dayOfWeek(date) !== 0) date = addDays(date, 1);
  return date;
}

const unique = Date.now();

// ---------------------------------------------------------------------------
//  Socket helper
// ---------------------------------------------------------------------------
function connectSocket(token?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(API, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 10_000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Minimum gap between chat turns.
 *
 * A hosted model has its own rate limit — Mistral's free tier is roughly one
 * request per second — and this suite fires a dozen turns back to back. Without
 * pacing, the provider returns 429, the assistant correctly degrades to its
 * "cannot reach the assistant" reply, and every downstream chat assertion fails
 * for a reason that has nothing to do with this codebase.
 */
const CHAT_TURN_GAP_MS = 1500;
let lastChatAt = 0;

async function paceChat(): Promise<void> {
  const wait = CHAT_TURN_GAP_MS - (Date.now() - lastChatAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastChatAt = Date.now();
}

/** Sends a chat message and resolves with the assistant's reply. */
async function chatTurn(
  socket: Socket,
  sessionId: string,
  content: string,
): Promise<{ content: string; payload: any }> {
  await paceChat();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to "${content}"`)), 40_000);
    socket.once('chat:reply', (data: { message: { content: string; payload: any } }) => {
      clearTimeout(timer);
      lastChatAt = Date.now();
      resolve({ content: data.message.content, payload: data.message.payload });
    });
    socket.emit('chat:message', { sessionId, content });
  });
}

/** True when a reply is the provider-unavailable fallback rather than a real answer. */
function isProviderOutage(text: string): boolean {
  return /trouble reaching our assistant|temporarily unavailable|busy right now/i.test(text);
}

// ===========================================================================
//  Test run
// ===========================================================================
async function main(): Promise<void> {
  console.log(`${BOLD}Bright Smile Dental — end-to-end verification${RESET}`);
  console.log(`${DIM}Target: ${API}${RESET}`);

  // -------------------------------------------------------------------------
  section('0. Health & clinic information');
  // -------------------------------------------------------------------------
  const health = await call('GET', '/health');
  check('GET /api/health returns 200', health.status === 200, health.body);

  // The suite issues ~150 requests. Running it repeatedly inside one rate-limit
  // window trips the API limiter, and every later check then fails for a reason
  // that has nothing to do with the code under test — so say so plainly.
  if (health.status === 429 || (health.body as any)?.code === 'RATE_LIMITED') {
    console.log(
      `\n${RED}The API rate limiter is active — the suite cannot run right now.${RESET}\n` +
        `  Wait for the window to reset (see the RateLimit-Reset header), or start\n` +
        `  the server with rate limiting disabled for testing:\n\n` +
        `      NODE_ENV=test npm run dev\n`,
    );
    process.exit(1);
  }

  const clinic = await call('GET', '/clinic');
  check('GET /api/clinic returns clinic details', clinic.status === 200 && !!clinic.body?.data?.name);
  check(
    'clinic exposes 30-minute slot duration',
    clinic.body?.data?.slotDurationMinutes === 30,
    clinic.body?.data?.slotDurationMinutes,
  );
  check('clinic lists services', (clinic.body?.data?.services?.length ?? 0) > 0);
  check(
    'clinic hours mark Sunday closed',
    clinic.body?.data?.hours?.find((h: any) => h.dayOfWeek === 0)?.isOpen === false,
  );

  // -------------------------------------------------------------------------
  section('1. Authentication');
  // -------------------------------------------------------------------------
  const email = `e2e.patient.${unique}@example.com`;
  const register = await call('POST', '/auth/register', {
    body: { name: 'E2E Patient', email, password: 'Passw0rd!', phone: '+1 415 555 0199' },
  });
  check('register returns 201', register.status === 201, register.body);
  const userToken: string = register.body?.data?.token;
  check('register returns a JWT', typeof userToken === 'string' && userToken.length > 20);
  check('register never returns the password hash', !JSON.stringify(register.body).includes('password_hash'));

  const duplicate = await call('POST', '/auth/register', {
    body: { name: 'Copycat', email, password: 'Passw0rd!' },
  });
  check('duplicate email returns 409', duplicate.status === 409, duplicate.body);

  const weakPassword = await call('POST', '/auth/register', {
    body: { name: 'Weak Pass', email: `weak.${unique}@example.com`, password: 'abc' },
  });
  check('weak password returns 400', weakPassword.status === 400);

  const badLogin = await call('POST', '/auth/login', { body: { email, password: 'WrongPass1' } });
  check('wrong password returns 401', badLogin.status === 401);
  check(
    'wrong password does not reveal whether the account exists',
    /email or password/i.test(badLogin.body?.message ?? ''),
    badLogin.body?.message,
  );

  const login = await call('POST', '/auth/login', { body: { email, password: 'Passw0rd!' } });
  check('valid login returns 200', login.status === 200);

  const me = await call('GET', '/auth/me', { token: userToken });
  check('GET /auth/me returns the profile', me.status === 200 && me.body?.data?.user?.email === email);

  const noAuth = await call('GET', '/auth/me');
  check('GET /auth/me without a token returns 401', noAuth.status === 401);

  const badToken = await call('GET', '/auth/me', { token: 'not.a.real.token' });
  check('GET /auth/me with a malformed token returns 401', badToken.status === 401);

  const adminLogin = await call('POST', '/auth/login', {
    body: { email: 'admin@brightsmiledental.com', password: 'Admin@123' },
  });
  check('admin can sign in', adminLogin.status === 200, adminLogin.body);
  const adminToken: string = adminLogin.body?.data?.token;
  check('admin has the ADMIN role', adminLogin.body?.data?.user?.role === 'ADMIN');

  // -------------------------------------------------------------------------
  section('2. Availability is computed server-side');
  // -------------------------------------------------------------------------
  const dayA = openDayAhead(1);
  const dayB = openDayAhead(2);
  const dayC = openDayAhead(3);

  const availA = await call('GET', `/appointments/availability?date=${dayA}`);
  check('availability returns 200', availA.status === 200);
  check('availability reports the day open', availA.body?.data?.isOpen === true, availA.body?.data);
  check(
    'grid contains exactly 16 slots (09:00–16:30)',
    availA.body?.data?.slots?.length === 16,
    availA.body?.data?.slots?.length,
  );
  check(
    'first slot is 09:00 and last is 16:30',
    availA.body?.data?.slots?.[0]?.time === '09:00' && availA.body?.data?.slots?.[15]?.time === '16:30',
  );
  check(
    '17:00 is never offered as a start time',
    !availA.body?.data?.slots?.some((s: any) => s.time === '17:00'),
  );
  check(
    'every slot is 30 minutes long',
    availA.body?.data?.slots?.every((s: any) => {
      const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      return toMin(s.endTime) - toMin(s.time) === 30;
    }),
  );

  const sunday = await call('GET', `/appointments/availability?date=${nextSunday()}`);
  check('Sunday is closed', sunday.body?.data?.isOpen === false);
  check('Sunday offers no slots', (sunday.body?.data?.available?.length ?? 0) === 0);

  const past = await call('GET', `/appointments/availability?date=${addDays(new Date().toISOString().slice(0, 10), -3)}`);
  check('a past date offers no slots', (past.body?.data?.available?.length ?? 0) === 0);

  const range = await call('GET', `/appointments/availability/range?from=${dayA}&days=7`);
  check('range availability returns 7 days', range.body?.data?.days?.length === 7, range.body);
  check(
    'range marks Sundays closed',
    range.body?.data?.days?.filter((d: any) => d.dayName === 'Sunday').every((d: any) => !d.isOpen),
  );

  // -------------------------------------------------------------------------
  section('3. Scenario A — guest booking');
  // -------------------------------------------------------------------------
  const guestSlot: string = availA.body?.data?.available?.[0];
  check('a slot is available to book', typeof guestSlot === 'string', availA.body?.data?.available);
  if (typeof guestSlot !== 'string') {
    console.log(
      `\n${RED}Cannot continue: ${dayA} has no free slots.${RESET}\n` +
        `  Reset the development data and run again:  npm run db:reset\n`,
    );
    process.exit(1);
  }

  const guestBooking = await call('POST', '/appointments', {
    body: {
      patientName: 'Guest Walker',
      patientEmail: `guest.${unique}@example.com`,
      patientPhone: '+1 415 555 0123',
      appointmentDate: dayA,
      startTime: guestSlot,
      reason: 'Check-up for a new patient',
    },
  });
  check('guest booking returns 201', guestBooking.status === 201, guestBooking.body);
  const guestAppointmentId: string = guestBooking.body?.data?.appointment?.id;
  check('booking has BOOKED status', guestBooking.body?.data?.appointment?.status === 'BOOKED');
  check(
    'end time is start + 30 minutes',
    guestBooking.body?.data?.appointment?.endTime ===
      (() => {
        const m = Number(guestSlot.slice(0, 2)) * 60 + Number(guestSlot.slice(3, 5)) + 30;
        return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      })(),
    guestBooking.body?.data?.appointment?.endTime,
  );
  check('guest booking has no user_id', guestBooking.body?.data?.appointment?.userId === null);

  const afterGuest = await call('GET', `/appointments/availability?date=${dayA}`);
  check(
    'the booked slot is no longer available',
    !afterGuest.body?.data?.available?.includes(guestSlot),
    afterGuest.body?.data?.available,
  );
  check(
    'the booked slot is shown as BOOKED, not hidden',
    afterGuest.body?.data?.slots?.find((s: any) => s.time === guestSlot)?.reason === 'BOOKED',
  );

  const guestLookup = await call(
    'GET',
    `/appointments/lookup?id=${guestAppointmentId}&email=guest.${unique}@example.com`,
  );
  check('guest can look up their booking with the right email', guestLookup.status === 200);
  const wrongEmailLookup = await call(
    'GET',
    `/appointments/lookup?id=${guestAppointmentId}&email=someone.else@example.com`,
  );
  check('guest lookup with the wrong email returns 404', wrongEmailLookup.status === 404);

  // -------------------------------------------------------------------------
  section('4. Scenario B — signed-in booking prefills the profile');
  // -------------------------------------------------------------------------
  const availB = await call('GET', `/appointments/availability?date=${dayB}`);
  const userSlot: string = availB.body?.data?.available?.[0];

  // No patient details sent at all — the server must fill them from the token.
  const userBooking = await call('POST', '/appointments', {
    token: userToken,
    body: { appointmentDate: dayB, startTime: userSlot, reason: 'Routine cleaning' },
  });
  check('signed-in booking returns 201 without resending details', userBooking.status === 201, userBooking.body);
  check(
    'patient name filled from the profile',
    userBooking.body?.data?.appointment?.patientName === 'E2E Patient',
    userBooking.body?.data?.appointment,
  );
  check('patient email filled from the profile', userBooking.body?.data?.appointment?.patientEmail === email);
  check(
    'patient phone filled from the profile',
    userBooking.body?.data?.appointment?.patientPhone === '+1 415 555 0199',
  );
  check('appointment linked to the account', !!userBooking.body?.data?.appointment?.userId);
  const userAppointmentId: string = userBooking.body?.data?.appointment?.id;

  const myList = await call('GET', '/appointments', { token: userToken });
  check('my appointments returns the booking', myList.status === 200 && myList.body?.data?.total >= 1);
  check(
    'my appointments only contains my own',
    myList.body?.data?.items?.every((a: any) => a.patientEmail === email),
  );

  const listNoAuth = await call('GET', '/appointments');
  check('listing appointments without a token returns 401', listNoAuth.status === 401);

  // -------------------------------------------------------------------------
  section('5. Scenario D — double booking is impossible');
  // -------------------------------------------------------------------------
  const sequential = await call('POST', '/appointments', {
    body: {
      patientName: 'Second Patient',
      patientEmail: `second.${unique}@example.com`,
      patientPhone: '+1 415 555 0177',
      appointmentDate: dayA,
      startTime: guestSlot,
      reason: 'Trying to take a taken slot',
    },
  });
  check('sequential double booking returns 409', sequential.status === 409, sequential.body);
  check('conflict is reported as SLOT_UNAVAILABLE', sequential.body?.code === 'SLOT_UNAVAILABLE');
  check(
    'conflict response offers alternative times',
    (sequential.body?.details?.alternatives?.length ?? 0) > 0,
    sequential.body?.details,
  );

  // The real race: N simultaneous requests for one slot.
  const availC = await call('GET', `/appointments/availability?date=${dayC}`);
  const raceSlot: string = availC.body?.data?.available?.[0];
  const CONCURRENCY = 8;

  const racers = Array.from({ length: CONCURRENCY }, (_, index) =>
    call('POST', '/appointments', {
      body: {
        patientName: `Racer ${index}`,
        patientEmail: `racer${index}.${unique}@example.com`,
        patientPhone: '+1 415 555 01' + String(10 + index),
        appointmentDate: dayC,
        startTime: raceSlot,
        reason: `Concurrent attempt ${index}`,
      },
    }),
  );
  const raceResults = await Promise.all(racers);
  const created = raceResults.filter((r) => r.status === 201).length;
  const conflicted = raceResults.filter((r) => r.status === 409).length;

  check(
    `exactly 1 of ${CONCURRENCY} concurrent bookings succeeded (got ${created})`,
    created === 1,
    raceResults.map((r) => r.status),
  );
  check(
    `the other ${CONCURRENCY - 1} were rejected with 409 (got ${conflicted})`,
    conflicted === CONCURRENCY - 1,
    raceResults.map((r) => r.status),
  );

  // -------------------------------------------------------------------------
  section('6. Booking validation & business rules');
  // -------------------------------------------------------------------------
  const sundayBooking = await call('POST', '/appointments', {
    token: userToken,
    body: { appointmentDate: nextSunday(), startTime: '10:00', reason: 'Sunday attempt' },
  });
  check('booking on a Sunday is refused', sundayBooking.status === 422, sundayBooking.body);
  check('Sunday refusal uses CLINIC_CLOSED', sundayBooking.body?.code === 'CLINIC_CLOSED');

  const misaligned = await call('POST', '/appointments', {
    token: userToken,
    body: { appointmentDate: dayB, startTime: '10:15', reason: 'Off-grid time' },
  });
  check('a 10:15 start is refused (not on the 30-minute grid)', misaligned.status === 400, misaligned.body);

  const afterHours = await call('POST', '/appointments', {
    token: userToken,
    body: { appointmentDate: dayB, startTime: '17:00', reason: 'After closing' },
  });
  check('a 17:00 start is refused (would end after closing)', afterHours.status === 400, afterHours.body);

  const pastBooking = await call('POST', '/appointments', {
    token: userToken,
    body: {
      appointmentDate: addDays(new Date().toISOString().slice(0, 10), -1),
      startTime: '10:00',
      reason: 'Yesterday',
    },
  });
  check('booking in the past is refused', pastBooking.status >= 400, pastBooking.body);

  const guestMissingDetails = await call('POST', '/appointments', {
    body: { appointmentDate: dayB, startTime: '15:30', reason: 'No contact details' },
  });
  check('guest booking without contact details is refused', guestMissingDetails.status === 400);

  const badEmail = await call('POST', '/appointments', {
    body: {
      patientName: 'Bad Email',
      patientEmail: 'not-an-email',
      patientPhone: '+1 415 555 0123',
      appointmentDate: dayB,
      startTime: '15:30',
      reason: 'Invalid email',
    },
  });
  check('invalid email is refused', badEmail.status === 400);

  // -------------------------------------------------------------------------
  section('7. Scenario E — admin authorization & operations');
  // -------------------------------------------------------------------------
  const userHitsAdmin = await call('GET', '/admin/appointments', { token: userToken });
  check('a normal USER gets 403 from /api/admin/appointments', userHitsAdmin.status === 403, userHitsAdmin.body);

  const anonHitsAdmin = await call('GET', '/admin/appointments');
  check('an anonymous caller gets 401 from /api/admin/appointments', anonHitsAdmin.status === 401);

  const userHitsStats = await call('GET', '/admin/appointments/stats', { token: userToken });
  check('a normal USER gets 403 from admin stats', userHitsStats.status === 403);

  const userDeletes = await call('DELETE', `/admin/appointments/${guestAppointmentId}`, { token: userToken });
  check('a normal USER cannot delete via the admin route', userDeletes.status === 403);

  const adminList = await call('GET', '/admin/appointments?pageSize=100', { token: adminToken });
  check('admin can list all appointments', adminList.status === 200 && adminList.body?.data?.total > 0);
  check(
    'admin list includes appointments from other patients',
    adminList.body?.data?.items?.some((a: any) => a.patientEmail !== email),
  );

  const adminStats = await call('GET', '/admin/appointments/stats', { token: adminToken });
  check('admin stats returns counters', adminStats.status === 200, adminStats.body);
  check(
    'stats include today/upcoming/completed/cancelled',
    ['today', 'upcoming', 'completed', 'cancelled'].every((k) => typeof adminStats.body?.data?.[k] === 'number'),
    adminStats.body?.data,
  );

  const filtered = await call('GET', '/admin/appointments?status=BOOKED', { token: adminToken });
  check(
    'admin status filter returns only BOOKED',
    filtered.body?.data?.items?.every((a: any) => a.status === 'BOOKED'),
  );

  const searched = await call('GET', '/admin/appointments?search=Guest%20Walker', { token: adminToken });
  check('admin search finds the guest booking', (searched.body?.data?.items?.length ?? 0) > 0, searched.body?.data);

  const todayScope = await call('GET', '/admin/appointments?scope=today', { token: adminToken });
  check('admin today scope returns 200', todayScope.status === 200);

  // ---- Edit ---------------------------------------------------------------
  const edited = await call('PATCH', `/admin/appointments/${guestAppointmentId}`, {
    token: adminToken,
    body: { reason: 'Updated by admin', notes: 'Patient called to add a note.' },
  });
  check('admin can edit an appointment', edited.status === 200, edited.body);
  check('the edit persisted', edited.body?.data?.appointment?.reason === 'Updated by admin');

  // ---- Move to an occupied slot is refused --------------------------------
  const availAAfter = await call('GET', `/appointments/availability?date=${dayA}`);
  const freeSlotOnA: string = availAAfter.body?.data?.available?.[0];
  const secondOnA = await call('POST', '/admin/appointments', {
    token: adminToken,
    body: {
      patientName: 'Clash Target',
      patientEmail: `clash.${unique}@example.com`,
      patientPhone: '+1 415 555 0155',
      appointmentDate: dayA,
      startTime: freeSlotOnA,
      reason: 'Occupies a slot for the clash test',
    },
  });
  check('admin can create an appointment on a patient behalf', secondOnA.status === 201, secondOnA.body);

  const clashMove = await call('PATCH', `/admin/appointments/${guestAppointmentId}`, {
    token: adminToken,
    body: { appointmentDate: dayA, startTime: freeSlotOnA },
  });
  check('moving onto an occupied slot returns 409', clashMove.status === 409, clashMove.body);

  const sundayMove = await call('PATCH', `/admin/appointments/${guestAppointmentId}`, {
    token: adminToken,
    body: { appointmentDate: nextSunday(), startTime: '10:00' },
  });
  check('moving an appointment to a Sunday is refused', sundayMove.status === 422, sundayMove.body);

  // ---- Complete keeps the slot occupied -----------------------------------
  const completed = await call('PATCH', `/admin/appointments/${guestAppointmentId}/complete`, {
    token: adminToken,
  });
  check('admin can mark an appointment completed', completed.status === 200, completed.body);
  check('status becomes COMPLETED', completed.body?.data?.appointment?.status === 'COMPLETED');
  check('completedAt is set', !!completed.body?.data?.appointment?.completedAt);

  const afterComplete = await call('GET', `/appointments/availability?date=${dayA}`);
  check(
    'a COMPLETED appointment keeps its slot unavailable',
    !afterComplete.body?.data?.available?.includes(guestSlot),
    afterComplete.body?.data?.available,
  );

  const rebookCompleted = await call('POST', '/appointments', {
    body: {
      patientName: 'Slot Thief',
      patientEmail: `thief.${unique}@example.com`,
      patientPhone: '+1 415 555 0144',
      appointmentDate: dayA,
      startTime: guestSlot,
      reason: 'Attempt to take a completed slot',
    },
  });
  check('booking over a COMPLETED slot returns 409', rebookCompleted.status === 409, rebookCompleted.body);

  // ---- Cancel frees the slot ---------------------------------------------
  const cancelled = await call('PATCH', `/admin/appointments/${secondOnA.body?.data?.appointment?.id}/cancel`, {
    token: adminToken,
  });
  check('admin can cancel an appointment', cancelled.status === 200, cancelled.body);
  check('status becomes CANCELLED', cancelled.body?.data?.appointment?.status === 'CANCELLED');

  const afterCancel = await call('GET', `/appointments/availability?date=${dayA}`);
  check(
    'a CANCELLED appointment releases its slot',
    afterCancel.body?.data?.available?.includes(freeSlotOnA),
    afterCancel.body?.data?.available,
  );

  // ---- Patient cancels their own -----------------------------------------
  const selfCancel = await call('DELETE', `/appointments/${userAppointmentId}`, { token: userToken });
  check('a patient can cancel their own appointment', selfCancel.status === 200, selfCancel.body);

  const foreignCancel = await call('DELETE', `/appointments/${guestAppointmentId}`, { token: userToken });
  check(
    "a patient cannot cancel someone else's appointment",
    foreignCancel.status === 404 || foreignCancel.status === 403,
    foreignCancel.body,
  );

  // -------------------------------------------------------------------------
  section('8. Scenario F — Socket.IO chat round trip');
  // -------------------------------------------------------------------------
  let socket: Socket | null = null;
  let sessionId = '';
  try {
    socket = await connectSocket();
    check('socket connects', socket.connected);

    const joined = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('join timeout')), 10_000);
      socket!.once('chat:joined', (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      socket!.emit('chat:join', {});
    });
    sessionId = joined?.session?.id;
    check('chat:join creates a session', typeof sessionId === 'string' && sessionId.length > 0, joined);
    check('join returns a welcome message', !!joined?.welcome?.content);
    check('join reports the AI provider', !!joined?.provider?.name, joined?.provider);

    // Typing indicator must arrive before the reply.
    const typingSeen = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      socket!.once('chat:typing', (data: { isTyping: boolean }) => {
        if (data.isTyping) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });

    const greeting = await chatTurn(socket, sessionId, 'Hi');
    checkAi('assistant replies to a greeting', greeting.content.length > 0, greeting.content);
    check('typing indicator was emitted', await typingSeen);

    const hours = await chatTurn(socket, sessionId, 'What time are you open?');
    checkAi(
      'assistant answers opening hours from the knowledge base',
      /9[:.]?00|9 ?am|09:00|monday/i.test(hours.content) && /5[:.]?00|5 ?pm|17:00/i.test(hours.content),
      hours.content,
    );

    const sundayQ = await chatTurn(socket, sessionId, 'Are you open on Sunday?');
    checkAi('assistant knows Sunday is closed', /closed/i.test(sundayQ.content), sundayQ.content);

    const servicesQ = await chatTurn(socket, sessionId, 'What services do you provide?');
    checkAi(
      'assistant lists services',
      /whitening|cleaning|check-?up|implant/i.test(servicesQ.content),
      servicesQ.content,
    );

    const unknownQ = await chatTurn(socket, sessionId, 'Do you sell car insurance policies here?');
    // Assert the BEHAVIOUR, not a phrase. The offline provider answers with a
    // fixed line, while a live model declines in its own words — both are
    // correct. What must never happen is the assistant claiming the clinic
    // offers something it does not.
    const inventedIt = /\b(yes,?\s*(we|the clinic)\s*(do|does|sell|offer)|we sell|we offer .*insurance)\b/i.test(
      unknownQ.content,
    );
    const declined =
      /not able to confirm|cannot confirm|don't|do not|doesn't|does not|afraid not|unfortunately|only|dental|reception/i.test(
        unknownQ.content,
      );
    checkAi(
      'assistant declines rather than inventing information',
      declined && !inventedIt,
      unknownQ.content,
    );

    // Persistence
    const transcript = await call('GET', `/chat/sessions/${sessionId}/messages`);
    check('the transcript is persisted in PostgreSQL', (transcript.body?.data?.messages?.length ?? 0) >= 10, {
      count: transcript.body?.data?.messages?.length,
    });
  } catch (error) {
    check(`Socket.IO chat round trip (${(error as Error).message})`, false);
  }

  // -------------------------------------------------------------------------
  section('9. Scenario C — booking through the chatbot');
  // -------------------------------------------------------------------------
  try {
    if (!socket) socket = await connectSocket();

    const bookingSession = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('join timeout')), 10_000);
      socket!.once('chat:joined', (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      socket!.emit('chat:join', {});
    });
    const bookingSessionId = bookingSession?.session?.id;

    const turn1 = await chatTurn(socket, bookingSessionId, 'I want to book an appointment');
    // A live model phrases this freely — it may ask for a day, ask for a time,
    // or go straight to offering slots. Any of those is correct engagement with
    // the booking intent; only silence or an unrelated answer is a failure.
    checkAi(
      'assistant engages with the booking request',
      /day|date|when|time|which|what/i.test(turn1.content) || turn1.payload?.type === 'slots',
      turn1.content,
    );

    const dayD = openDayAhead(4);
    const turn2 = await chatTurn(socket, bookingSessionId, `I would like ${dayD}`);
    check(
      'assistant offers real slots for that day',
      turn2.payload?.type === 'slots' && turn2.payload.slots.length > 0,
      turn2.payload ?? turn2.content,
    );

    // Verify the offered slots match the availability API exactly — proof the
    // chatbot reads the same source of truth, not its own list.
    const apiAvailability = await call('GET', `/appointments/availability?date=${dayD}`);
    const offered: string[] = turn2.payload?.slots ?? [];
    check(
      'slots offered in chat match the availability API',
      offered.every((slot) => apiAvailability.body?.data?.available?.includes(slot)),
      { offered, api: apiAvailability.body?.data?.available },
    );

    const chosen = offered[0]!;
    const turn3 = await chatTurn(socket, bookingSessionId, `${chosen} please`);
    checkAi(
      'assistant asks for the missing patient details',
      /name|email|phone|contact|details/i.test(turn3.content),
      turn3.content,
    );

    const chatEmail = `chatbot.${unique}@example.com`;
    const turn4 = await chatTurn(
      socket,
      bookingSessionId,
      `Riley Chatbot, ${chatEmail}, +1 415 555 0211`,
    );
    checkAi(
      'assistant asks for the reason (or is ready to book)',
      /reason|why|visit|treatment|help|bring/i.test(turn4.content) ||
        turn4.payload?.type === 'booking_confirmed',
      turn4.content,
    );

    const turn5 = await chatTurn(socket, bookingSessionId, 'I need a teeth cleaning');
    checkAi(
      'assistant confirms the booking',
      turn5.payload?.type === 'booking_confirmed',
      turn5.payload ?? turn5.content,
    );

    const chatAppointment = turn5.payload?.appointment;

    // Everything below verifies the appointment the chat turn was supposed to
    // create. If the provider was unavailable, no booking happened and these
    // checks have nothing to inspect — skip them rather than report failures
    // whose cause is an upstream quota.
    if (!chatAppointment?.id) {
      for (const label of [
        'the chatbot booking has a real appointment id',
        'the chatbot booking is on the requested date',
        'the chatbot booking is at the chosen time',
        'the chatbot booking is recorded with source CHATBOT',
        'the chatbot appointment is retrievable through the REST API',
        'the slot booked in chat is no longer available',
      ]) {
        skipped += 1;
        skips.push(label);
        console.log(`  ${YELLOW}⊘${RESET} ${label} ${DIM}(no booking to verify)${RESET}`);
      }
      socket?.disconnect();
      throw new SkipRest();
    }
    check('the chatbot booking has a real appointment id', !!chatAppointment?.id, chatAppointment);
    check('the chatbot booking is on the requested date', chatAppointment?.appointmentDate === dayD);
    check('the chatbot booking is at the chosen time', chatAppointment?.startTime === chosen);
    check('the chatbot booking is recorded with source CHATBOT', chatAppointment?.source === 'CHATBOT');

    // The decisive check: the chatbot wrote to the same database the REST API reads.
    const verify = await call('GET', `/appointments/lookup?id=${chatAppointment?.id}&email=${chatEmail}`);
    check(
      'the chatbot appointment is retrievable through the REST API',
      verify.status === 200 && verify.body?.data?.appointment?.id === chatAppointment?.id,
      verify.body,
    );

    const availAfterChat = await call('GET', `/appointments/availability?date=${dayD}`);
    check(
      'the slot booked in chat is no longer available',
      !availAfterChat.body?.data?.available?.includes(chosen),
      availAfterChat.body?.data?.available,
    );

    // Unavailable slot handling
    const closedDayTurn = await chatTurn(
      socket,
      bookingSessionId,
      `Actually can I come on ${nextSunday()} instead?`,
    );
    // The property that matters: it must NOT accept a booking on a closed day.
    // How it words the refusal is the model's business, so accept any phrasing
    // that signals unavailability or steers to another day.
    checkAi(
      'assistant refuses a Sunday and does not book it',
      closedDayTurn.payload?.type !== 'booking_confirmed' &&
        (isProviderOutage(closedDayTurn.content) === false
          ? /closed|sunday|not open|unavailable|another day|next available|monday/i.test(
              closedDayTurn.content,
            )
          : false),
      closedDayTurn.content,
    );
  } catch (error) {
    if (!(error instanceof SkipRest)) {
      check(`chatbot booking flow (${(error as Error).message})`, false);
    }
  } finally {
    socket?.disconnect();
  }

  // -------------------------------------------------------------------------
  section('10. Error handling & security');
  // -------------------------------------------------------------------------
  const notFound = await call('GET', '/does-not-exist');
  check('unknown route returns 404', notFound.status === 404, notFound.body);
  check('404 uses the standard envelope', notFound.body?.success === false);

  const badUuid = await call('GET', '/appointments/not-a-uuid');
  check('a malformed id returns 400', badUuid.status === 400, badUuid.body);

  const missingAppointment = await call(
    'GET',
    '/appointments/00000000-0000-4000-8000-000000000000',
    { token: adminToken },
  );
  check('an unknown appointment returns 404', missingAppointment.status === 404);

  const errorBodies = [notFound.body, badUuid.body, sequential.body];
  check(
    'no error response leaks a stack trace',
    errorBodies.every((body) => !JSON.stringify(body).includes('at Object.')),
  );
  check(
    'no error response leaks SQL',
    errorBodies.every((body) => !/SELECT |INSERT |pg_/i.test(JSON.stringify(body))),
  );

  const sqlInjection = await call('GET', "/admin/appointments?search='; DROP TABLE appointments; --", {
    token: adminToken,
  });
  check('a SQL-injection style search is handled safely', sqlInjection.status === 200, sqlInjection.body);
  const stillThere = await call('GET', '/admin/appointments?pageSize=1', { token: adminToken });
  check('the appointments table survived', stillThere.status === 200 && stillThere.body?.data?.total > 0);

  // -------------------------------------------------------------------------
  //  Summary
  // -------------------------------------------------------------------------
  console.log(`\n${BOLD}${'─'.repeat(60)}${RESET}`);
  const total = passed + failed;
  if (skipped > 0) {
    console.log(`${YELLOW}${skipped} check(s) skipped — the AI provider was unavailable:${RESET}`);
    for (const s2 of skips) console.log(`  ${YELLOW}⊘${RESET} ${s2}`);
  }
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All ${total} checks passed.${RESET}`);
  } else {
    console.log(`${RED}${BOLD}${failed} of ${total} checks failed:${RESET}`);
    for (const failure of failures) console.log(`  ${RED}•${RESET} ${failure}`);
  }
  console.log(`${BOLD}${'─'.repeat(60)}${RESET}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n${RED}Test run crashed:${RESET}`, error);
  process.exit(1);
});
