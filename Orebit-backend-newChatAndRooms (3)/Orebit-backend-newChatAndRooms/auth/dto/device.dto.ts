import { z } from 'zod';

/**
 * `POST /auth/device` — remember this browser, or forget one.
 *
 * Authenticated, and that is what makes remember-me cheap here. Asking "trust this
 * device?" *after* a session exists means password login, email-OTP login and
 * Google all reach the same endpoint, instead of each threading a `rememberMe`
 * flag through its own multi-step flow.
 *
 * `trust` names no device: the one being trusted is whichever browser sent the
 * request, identified by its `orebit_device` cookie. A device id in the body would
 * let a caller trust a browser they are not holding, which is precisely the thing
 * device binding exists to prevent.
 */

const trustSchema = z.object({
  action: z.literal('trust'),
});

const untrustSchema = z.object({
  action: z.literal('untrust'),
  /** Which remembered device to forget — from `GET /auth/sessions`. Ownership is
   *  enforced in the query, never by trusting this value. */
  deviceId: z.string().uuid(),
});

export const deviceRequestSchema = z.discriminatedUnion('action', [trustSchema, untrustSchema]);

export type DeviceRequest = z.infer<typeof deviceRequestSchema>;
export type DeviceTrustRequest = z.infer<typeof trustSchema>;
export type DeviceUntrustRequest = z.infer<typeof untrustSchema>;
