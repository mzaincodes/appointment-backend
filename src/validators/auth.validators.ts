import { z } from 'zod';

/**
 * Auth request schemas.
 *
 * Validators live beside each other rather than inline in routes so the rules
 * are reviewable in one place, and so the same schema can be reused by the
 * chatbot's tool layer where the shapes overlap.
 */

const emailSchema = z
  .string({ required_error: 'Email address is required.' })
  .trim()
  .min(1, 'Email address is required.')
  .max(255, 'That email address is too long.')
  .email('Please enter a valid email address.')
  .transform((value) => value.toLowerCase());

/**
 * Password policy.
 *
 * Length plus a mix of character classes. Deliberately not stricter than this:
 * rules that force exotic symbols push people toward reused or written-down
 * passwords, which is a worse outcome than a slightly smaller keyspace.
 */
const passwordSchema = z
  .string({ required_error: 'Password is required.' })
  .min(8, 'Password must be at least 8 characters.')
  .max(72, 'Password must be 72 characters or fewer.') // bcrypt truncates beyond 72 bytes
  .regex(/[a-z]/, 'Password must include a lowercase letter.')
  .regex(/[A-Z]/, 'Password must include an uppercase letter.')
  .regex(/[0-9]/, 'Password must include a number.');

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()\-]{7,25}$/, 'Please enter a valid phone number.');

export const nameSchema = z
  .string({ required_error: 'Name is required.' })
  .trim()
  .min(2, 'Name must be at least 2 characters.')
  .max(120, 'Name must be 120 characters or fewer.');

export const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  // Optional at signup, but an empty string is normalised to "absent" so the
  // database stores NULL rather than '' and the CHECK constraint is satisfied.
  phone: phoneSchema.optional().or(z.literal('').transform(() => undefined)),
});

export const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email address is required.').toLowerCase(),
  password: z.string().min(1, 'Password is required.'),
});

export const updateProfileSchema = z
  .object({
    name: nameSchema.optional(),
    phone: phoneSchema.nullable().optional().or(z.literal('').transform(() => null)),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'There is nothing to update.',
  });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Your current password is required.'),
  newPassword: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
