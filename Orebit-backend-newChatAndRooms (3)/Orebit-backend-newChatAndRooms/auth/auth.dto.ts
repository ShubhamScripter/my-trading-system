/**
 * The module's DTO surface.
 *
 * README.md's convention gives each module a single `<name>.dto.ts`. The request
 * schemas for five routes plus their response shapes do not fit one file under
 * the 500-line limit, so they are split by flow and this barrel keeps the
 * convention's entry point: `auth.controller.ts` and `auth.routes.ts` import from
 * here, and the split stays an internal detail to everything but `dto/` itself.
 *
 * Nothing outside `auth/` imports this file. The auth DTOs are request and
 * response shapes for auth's own five routes; another module needing one would be
 * a sign that route belongs elsewhere. `PublicUserPayload` used to be the
 * exception — owned by `src/user` and re-exported inward — but accounts now live
 * here too, so `dto/response.dto.ts` defines it and there is no longer a shape in
 * this module that another module owns.
 *
 *   common.dto.ts     field-level schemas shared by all of the below
 *   register.dto.ts   POST /auth/register   (7 steps)
 *   login.dto.ts      POST /auth/login      (5 modes)
 *   session.dto.ts    POST /auth/session    (4 actions)
 *   device.dto.ts     POST /auth/device     (2 actions)
 *   password.dto.ts   POST /auth/password   (2 actions)
 *   response.dto.ts   every response shape
 */

export {
  captchaSchema,
  characterClassCount,
  classifyIdentifier,
  countrySchema,
  emailSchema,
  identifierSchema,
  otpCodeSchema,
  passwordSchema,
  referralCodeSchema,
  updateMyProfileRequestSchema,
  usernameSchema,
  type IdentifierKind,
  type UpdateMyProfileRequest,
} from './dto/common.dto';

export {
  registerRequestSchema,
  type RegisterCheckReferralRequest,
  type RegisterTrustDeviceRequest,
  type RegisterCountryRequest,
  type RegisterCredentialsRequest,
  type RegisterRequest,
  type RegisterResendOtpRequest,
  type RegisterStartRequest,
  type RegisterStateRequest,
  type RegisterVerifyEmailRequest,
} from './dto/register.dto';

export {
  loginRequestSchema,
  type LoginOauthCallbackRequest,
  type LoginOauthStartRequest,
  type LoginOtpRequestRequest,
  type LoginOtpVerifyRequest,
  type LoginPasswordRequest,
  type LoginRequest,
} from './dto/login.dto';

export {
  sessionRequestSchema,
  type RevokeSessionRequest,
  type SessionLogoutRequest,
  type SessionRequest,
} from './dto/session.dto';

export {
  deviceRequestSchema,
  type DeviceRequest,
  type DeviceTrustRequest,
  type DeviceUntrustRequest,
} from './dto/device.dto';

export {
  passwordRequestSchema,
  type PasswordChangeRequest,
  type PasswordRequest,
  type PasswordRequestCodeRequest,
  type PasswordSetRequest,
} from './dto/password.dto';

export {
  toCaptchaPayload,
  toPublicUserPayload,
  toSessionPayload,
  type CaptchaOptionPayload,
  type CaptchaPayload,
  type EmptyPayload,
  type LoginPayload,
  type MePayload,
  type PublicUserPayload,
  type LogoutPayload,
  type ReferralCheckPayload,
  type RegistrationStartPayload,
  type RegistrationStatePayload,
  type DeviceGroupPayload,
  type SessionListPayload,
  type SessionPayload,
  type SessionStatusPayload,
  type SessionSummaryPayload,
} from './dto/response.dto';
