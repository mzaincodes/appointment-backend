/**
 * Domain types shared across the backend.
 *
 * Two conventions are used deliberately:
 *
 *  - `*Row` types mirror a database row exactly (snake_case, nullable columns).
 *    Only repositories deal in these.
 *  - The plain types are the API/domain shape (camelCase). Repositories map
 *    `*Row` -> domain on the way out, so no snake_case ever leaks to a client.
 */

// ---------------------------------------------------------------------------
//  Users
// ---------------------------------------------------------------------------
export type UserRole = 'USER' | 'ADMIN';

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  phone: string | null;
  role: UserRole;
  created_at: Date;
  updated_at: Date;
}

/** A user as returned by the API — never contains the password hash. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

/** Decoded JWT payload. Kept minimal: everything else is looked up per request. */
export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

// ---------------------------------------------------------------------------
//  Appointments
// ---------------------------------------------------------------------------
export type AppointmentStatus = 'BOOKED' | 'COMPLETED' | 'CANCELLED';
export type AppointmentSource = 'WEB' | 'CHATBOT' | 'ADMIN';

export interface AppointmentRow {
  id: string;
  user_id: string | null;
  patient_name: string;
  patient_email: string;
  patient_phone: string;
  appointment_date: string; // 'YYYY-MM-DD' — see db/pool.ts type parsers
  start_time: string; // 'HH:mm:ss'
  end_time: string; // 'HH:mm:ss'
  service_id: string | null;
  reason: string;
  notes: string | null;
  status: AppointmentStatus;
  source: AppointmentSource;
  cancelled_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  // Present when the query joins `services`.
  service_name?: string | null;
  service_slug?: string | null;
}

export interface Appointment {
  id: string;
  userId: string | null;
  patientName: string;
  patientEmail: string;
  patientPhone: string;
  appointmentDate: string; // 'YYYY-MM-DD'
  startTime: string; // 'HH:mm'
  endTime: string; // 'HH:mm'
  serviceId: string | null;
  serviceName: string | null;
  reason: string;
  notes: string | null;
  status: AppointmentStatus;
  source: AppointmentSource;
  cancelledAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAppointmentInput {
  userId: string | null;
  patientName: string;
  patientEmail: string;
  patientPhone: string;
  appointmentDate: string;
  startTime: string;
  serviceId?: string | null;
  reason: string;
  notes?: string | null;
  source?: AppointmentSource;
}

export interface UpdateAppointmentInput {
  patientName?: string;
  patientEmail?: string;
  patientPhone?: string;
  appointmentDate?: string;
  startTime?: string;
  serviceId?: string | null;
  reason?: string;
  notes?: string | null;
  status?: AppointmentStatus;
}

export interface AppointmentFilters {
  status?: AppointmentStatus | AppointmentStatus[];
  from?: string;
  to?: string;
  date?: string;
  search?: string;
  userId?: string;
  email?: string;
  /**
   * Restricts results to one patient's appointments, matching on account id
   * **or** email address (an OR, unlike the independent `userId`/`email`
   * filters above). Bookings made as a guest before the account existed carry
   * no `user_id`, so matching on the address as well is what makes them appear
   * in "My appointments".
   */
  owner?: { userId: string; email: string };
  scope?: 'today' | 'upcoming' | 'past';
  page?: number;
  pageSize?: number;
  sort?: 'date_asc' | 'date_desc' | 'created_desc';
}

/** One entry in the availability grid returned to the booking UI. */
export interface SlotView {
  time: string; // 'HH:mm'
  endTime: string; // 'HH:mm'
  label: string; // '2:30 PM'
  available: boolean;
  /** Why the slot cannot be picked. `null` when it is bookable. */
  reason: 'BOOKED' | 'PAST' | 'CLOSED' | null;
}

export interface DayAvailability {
  date: string;
  dayName: string;
  isOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
  slotDurationMinutes: number;
  /** Bookable start times only — the shape the assessment specifies. */
  available: string[];
  /** Full grid including unavailable slots, so the UI can grey them out. */
  slots: SlotView[];
  message?: string;
}

export interface AppointmentStats {
  today: number;
  upcoming: number;
  completed: number;
  cancelled: number;
  total: number;
  todayRemaining: number;
}

// ---------------------------------------------------------------------------
//  Clinic
// ---------------------------------------------------------------------------
export interface ClinicHoursRow {
  day_of_week: number;
  is_open: boolean;
  opens_at: string | null;
  closes_at: string | null;
}

export interface ClinicHours {
  dayOfWeek: number;
  dayName: string;
  isOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

export interface Service {
  id: string;
  slug: string;
  name: string;
  description: string;
  durationMin: number;
  priceFrom: number | null;
  icon: string | null;
  displayOrder: number;
}

export interface KnowledgeDocument {
  id: string;
  category: string;
  title: string;
  content: string;
  priority: number;
}

/** A knowledge document plus the score that caused it to be retrieved. */
export interface RetrievedDocument extends KnowledgeDocument {
  score: number;
}

// ---------------------------------------------------------------------------
//  Chat
// ---------------------------------------------------------------------------
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatSession {
  id: string;
  userId: string | null;
  title: string | null;
  bookingContext: BookingContext;
  createdAt: string;
  lastMessageAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  payload: MessagePayload | null;
  createdAt: string;
}

/**
 * Structured attachments the chat UI renders as rich elements. Persisting these
 * alongside the text means a reloaded conversation redraws its slot pickers and
 * confirmation cards instead of degrading to plain text.
 */
export type MessagePayload =
  | { type: 'slots'; date: string; dayName: string; slots: string[]; message?: string }
  | { type: 'booking_confirmed'; appointment: Appointment }
  | { type: 'appointment_list'; appointments: Appointment[] }
  | { type: 'appointment_cancelled'; appointmentId: string }
  | { type: 'services'; services: Service[] }
  | { type: 'quick_replies'; options: string[] };

/**
 * The assistant's multi-turn scratchpad, persisted on the session.
 *
 * This is what stops the bot re-asking for a date it was already given. It is
 * filled incrementally as the conversation reveals details, and it is *data*,
 * not instructions — the booking rules that read it live in the appointment
 * service.
 */
export interface BookingContext {
  intent?: 'booking' | 'cancel' | 'reschedule' | 'information' | null;
  date?: string | null;
  time?: string | null;
  timePreference?: 'morning' | 'afternoon' | 'any' | null;
  patientName?: string | null;
  patientEmail?: string | null;
  patientPhone?: string | null;
  reason?: string | null;
  serviceSlug?: string | null;
  notes?: string | null;
  /** Set once an appointment is created, so a repeat message cannot rebook. */
  appointmentId?: string | null;
  stage?: 'collecting' | 'confirming' | 'completed' | null;
}

// ---------------------------------------------------------------------------
//  API envelope
// ---------------------------------------------------------------------------
export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiFailure {
  success: false;
  message: string;
  code?: string;
  details?: unknown;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
