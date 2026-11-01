import type { Mail } from './mail.service';

/**
 * Email bodies. Pure functions returning both parts of a multipart message —
 * no I/O, no template engine, no filesystem reads at request time.
 *
 * Every value interpolated into the HTML goes through `escape` below. The codes
 * are generated server-side, so today nothing here can carry markup — but "the
 * input happens to be safe" is not a property that survives the next field
 * someone adds.
 *
 * The wording differs from the consumer backend's on purpose. These messages go
 * to a small set of staff who each hold real authority over the platform, so
 * every one of them names the action being authorised and says plainly what to do
 * if it was not them. "Ignore this email" is the wrong advice for an admin who
 * just received a sign-in code they did not ask for.
 */

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(heading: string, body: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1d21">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
    <p style="margin:0 0 24px;font-size:18px;font-weight:600;letter-spacing:-0.01em">OREBiT <span style="font-weight:400;color:#6b7280">Admin</span></p>
    <h1 style="margin:0 0 16px;font-size:20px;font-weight:600">${escape(heading)}</h1>
    ${body}
  </div>
</body></html>`;
}

function codeBlock(code: string): string {
  return `<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:0.18em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escape(code)}</p>`;
}

function alert(text: string): string {
  return `<p style="margin:16px 0 0;padding:12px 14px;background:#fef2f2;border-left:3px solid #dc2626;font-size:13px;line-height:1.5;color:#7f1d1d">${escape(text)}</p>`;
}

/**
 * The sign-in code, sent after a correct password.
 *
 * Receiving this without having just tried to sign in means someone else has the
 * password — so the alert is a direct instruction, not a footnote.
 */
export function loginOtpEmail(to: string, code: string, minutesValid: number): Mail {
  return {
    to,
    subject: `${code} is your OREBiT admin sign-in code`,
    text:
      `Your OREBiT admin sign-in code is ${code}.\n\n` +
      `It expires in ${minutesValid} minutes.\n\n` +
      `If you did not just sign in, your password is compromised. ` +
      `Reset it immediately and notify the platform team.`,
    html: layout(
      'Confirm your sign-in',
      `${codeBlock(code)}
       <p style="margin:0 0 8px;font-size:14px;line-height:1.5">This code expires in ${minutesValid} minutes.</p>
       ${alert('If you did not just sign in, your password is compromised. Reset it immediately and notify the platform team.')}`,
    ),
  };
}

/**
 * Sent when a second factor is enrolled or a password is changed.
 *
 * A notification, not a challenge — there is nothing to click and no code to
 * enter. It exists so that an attacker who reaches the enrollment step cannot do
 * it silently: the real owner finds out even though the flow itself succeeded.
 */
export function securityChangedEmail(to: string, change: string, at: Date): Mail {
  const when = at.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return {
    to,
    subject: `Security change on your OREBiT admin account`,
    text:
      `${change} on your OREBiT admin account at ${when}.\n\n` +
      `If this was not you, your account is compromised. ` +
      `Contact the platform team immediately.`,
    html: layout(
      'Security change on your account',
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5"><strong>${escape(change)}</strong></p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280">${escape(when)}</p>
       ${alert('If this was not you, your account is compromised. Contact the platform team immediately.')}`,
    ),
  };
}
