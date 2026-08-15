import { Router } from 'express';
import { z } from 'zod';

import { authController } from '../controllers/auth.controller';
import { appointmentController, adminAppointmentController } from '../controllers/appointment.controller';
import { chatController } from '../controllers/chat.controller';
import { clinicController } from '../controllers/clinic.controller';

import { asyncHandler } from '../middleware/async-handler';
import { optionalAuth, requireAdmin, requireAuth } from '../middleware/auth';
import { authLimiter, chatLimiter } from '../middleware/rate-limit';
import { validate } from '../middleware/validate';

import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from '../validators/auth.validators';
import {
  availabilityQuerySchema,
  availabilityRangeQuerySchema,
  createAppointmentSchema,
  guestLookupSchema,
  idParamSchema,
  listAppointmentsQuerySchema,
  rescheduleSchema,
  updateAppointmentSchema,
} from '../validators/appointment.validators';

/**
 * API routes.
 *
 * Each line reads as a policy statement: path, who may call it, what shape the
 * input must take, and which controller handles it. Authorisation is visible at
 * the routing layer *and* re-checked inside the services, so a mistake here
 * cannot silently expose data.
 */

const router = Router();

// ---------------------------------------------------------------------------
//  Health
// ---------------------------------------------------------------------------
router.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
});

// ---------------------------------------------------------------------------
//  Auth  —  /api/auth
// ---------------------------------------------------------------------------
const auth = Router();

auth.post(
  '/register',
  authLimiter,
  validate({ body: registerSchema }),
  asyncHandler(authController.register),
);
auth.post('/login', authLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));
auth.post('/logout', asyncHandler(authController.logout));
auth.get('/me', requireAuth, asyncHandler(authController.me));
auth.patch(
  '/me',
  requireAuth,
  validate({ body: updateProfileSchema }),
  asyncHandler(authController.updateProfile),
);
auth.post(
  '/change-password',
  requireAuth,
  authLimiter,
  validate({ body: changePasswordSchema }),
  asyncHandler(authController.changePassword),
);

router.use('/auth', auth);

// ---------------------------------------------------------------------------
//  Clinic  —  /api/clinic  (public)
// ---------------------------------------------------------------------------
const clinic = Router();
clinic.get('/', asyncHandler(clinicController.getInfo));
clinic.get('/hours', asyncHandler(clinicController.getHours));
clinic.get('/services', asyncHandler(clinicController.getServices));
clinic.get('/faq', asyncHandler(clinicController.getFaq));
router.use('/clinic', clinic);

// ---------------------------------------------------------------------------
//  Appointments  —  /api/appointments
// ---------------------------------------------------------------------------
const appointments = Router();

// Availability is public: the booking calendar must work before sign-in.
// These are declared before `/:id` so the literal paths are not captured by it.
appointments.get(
  '/availability',
  validate({ query: availabilityQuerySchema }),
  asyncHandler(appointmentController.availability),
);
appointments.get(
  '/availability/range',
  validate({ query: availabilityRangeQuerySchema }),
  asyncHandler(appointmentController.availabilityRange),
);
appointments.get('/next-available', asyncHandler(appointmentController.nextAvailable));
appointments.get(
  '/lookup',
  validate({ query: guestLookupSchema }),
  asyncHandler(appointmentController.guestLookup),
);

// Booking works signed out; `optionalAuth` attaches the user when present so
// the service can prefill details and link the appointment to the account.
appointments.post(
  '/',
  optionalAuth,
  validate({ body: createAppointmentSchema }),
  asyncHandler(appointmentController.create),
);

appointments.get(
  '/',
  requireAuth,
  validate({ query: listAppointmentsQuerySchema }),
  asyncHandler(appointmentController.list),
);
appointments.get(
  '/:id',
  optionalAuth,
  validate({ params: idParamSchema }),
  asyncHandler(appointmentController.getById),
);
appointments.patch(
  '/:id',
  requireAuth,
  validate({ params: idParamSchema, body: rescheduleSchema }),
  asyncHandler(appointmentController.reschedule),
);
appointments.delete(
  '/:id',
  requireAuth,
  validate({ params: idParamSchema }),
  asyncHandler(appointmentController.cancel),
);

router.use('/appointments', appointments);

// ---------------------------------------------------------------------------
//  Chat  —  /api/chat
// ---------------------------------------------------------------------------
//  Socket.IO is the primary transport. These endpoints load transcripts and act
//  as a fallback where websockets are blocked.
const chat = Router();

chat.post(
  '/sessions',
  optionalAuth,
  validate({ body: z.object({ sessionId: z.string().uuid().optional() }) }),
  asyncHandler(chatController.createSession),
);
chat.get('/sessions', requireAuth, asyncHandler(chatController.listSessions));
chat.get(
  '/sessions/:id/messages',
  optionalAuth,
  validate({ params: idParamSchema }),
  asyncHandler(chatController.getMessages),
);
chat.post(
  '/sessions/:id/messages',
  optionalAuth,
  chatLimiter, // AI calls are the only ones that cost money per request
  validate({
    params: idParamSchema,
    body: z.object({
      content: z
        .string()
        .trim()
        .min(1, 'Please type a message.')
        .max(2000, 'Messages are limited to 2000 characters.'),
    }),
  }),
  asyncHandler(chatController.sendMessage),
);

router.use('/chat', chat);

// ---------------------------------------------------------------------------
//  Admin  —  /api/admin
// ---------------------------------------------------------------------------
//  `requireAuth` then `requireAdmin` are applied to the whole router, so every
//  route below is guarded regardless of what is added later. A signed-in USER
//  receives 403 here no matter what the frontend renders.
const admin = Router();
admin.use(requireAuth, requireAdmin);

admin.get(
  '/appointments',
  validate({ query: listAppointmentsQuerySchema }),
  asyncHandler(adminAppointmentController.list),
);
admin.get('/appointments/stats', asyncHandler(adminAppointmentController.stats));
admin.post(
  '/appointments',
  validate({ body: createAppointmentSchema }),
  asyncHandler(adminAppointmentController.create),
);
admin.get(
  '/appointments/:id',
  validate({ params: idParamSchema }),
  asyncHandler(adminAppointmentController.getById),
);
admin.patch(
  '/appointments/:id',
  validate({ params: idParamSchema, body: updateAppointmentSchema }),
  asyncHandler(adminAppointmentController.update),
);
admin.patch(
  '/appointments/:id/complete',
  validate({ params: idParamSchema }),
  asyncHandler(adminAppointmentController.complete),
);
admin.patch(
  '/appointments/:id/cancel',
  validate({ params: idParamSchema }),
  asyncHandler(adminAppointmentController.cancel),
);
admin.delete(
  '/appointments/:id',
  validate({ params: idParamSchema }),
  asyncHandler(adminAppointmentController.remove),
);

router.use('/admin', admin);

export default router;
