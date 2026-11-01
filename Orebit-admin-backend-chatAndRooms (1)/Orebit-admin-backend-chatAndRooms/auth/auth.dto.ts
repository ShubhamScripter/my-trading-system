/**
 * The `auth/` DTO barrel.
 *
 * One import site for the controller, so adding a schema is one edit in `dto/`
 * rather than two files that can disagree about what exists.
 */

export {
  captchaProviderSchema,
  captchaTokenSchema,
  emailSchema,
  loginIdSchema,
  otpSchema,
  passwordSchema,
  presentedPasswordSchema,
  webauthnResponseSchema,
} from './dto/common.dto';

export { loginRequestSchema, type LoginRequest, type PasswordStepRequest } from './dto/login.dto';
export { sessionRequestSchema, type SessionRequest } from './dto/session.dto';

export {
  toAdminPayload,
  toCaptchaPayload,
  toLoginPayload,
  toSessionPayload,
  type AdminPayload,
  type CaptchaPayload,
  type LogoutPayload,
  type LoginPayload,
  type MePayload,
  type SessionPayload,
  type SessionStatusPayload,
  type TotpEnrollmentPayload,
} from './dto/response.dto';
