import { apiFetch } from "./client";
import type { User } from "@/types/chat";

export interface AuthSession {
  accessToken: string;
  user: User;
}

export interface SignupForm {
  email: string;
  username: string;
  password: string;
  country: string;
}

/** The shape of a raw `/auth/signup` or `/auth/login` response, across every
 *  envelope the backend has shipped a session under. */
interface AuthResponseEnvelope {
  accessToken?: string;
  user?: User;
  data?: {
    accessToken?: string;
    user?: User;
    session?: { accessToken?: string; user?: User };
  };
  session?: { accessToken?: string; user?: User };
}

/** Tries each known envelope shape, in the same order the UI already did. */
function extractSession(data: any): AuthSession | null {
  if (!data) return null;
  const user = data.user ?? data.data?.user ?? data.data?.session?.user ?? data.session?.user;
  const accessToken =
    data.accessToken ??
    data.data?.accessToken ??
    data.data?.csrfToken ??
    data.data?.session?.accessToken ??
    data.session?.accessToken ??
    "session-authenticated";
  return user ? { accessToken, user } : null;
}

/** Returns null when the response was ok but carried no recognizable
 *  session — the caller decides what to do next (the signup flow falls
 *  back to an explicit login). */
export async function signup(form: SignupForm): Promise<AuthSession | null> {
  const data = await apiFetch<AuthResponseEnvelope>("/auth/signup", {
    method: "POST",
    body: form,
    fallbackMessage: "Registration failed on server",
  });
  return extractSession(data);
}

export async function login(
  identifier: string,
  password: string,
): Promise<AuthSession | null> {
  const data = await apiFetch<AuthResponseEnvelope>("/auth/login", {
    method: "POST",
    body: {
      step: "password",
      identifier,
      password,
      captchaProvider: "TURNSTILE",
      captchaToken: "XXXX.DUMMY.TOKEN.XXXX",
    },
    fallbackMessage: "Login failed: Invalid credentials",
  });
  return extractSession(data);
}

/** Ends this browser's session on the server, so every open chat tab is signed out within ~5 s (D-24). */
export async function logout(): Promise<void> {
  await apiFetch("/auth/session", { method: "POST", body: { action: "logout" } });
}

/**
 * The signed-in user from the session cookie, or null. Also refreshes the session's access token on the server, which
 * the chat socket needs when it answers `session_refresh_required`.
 */
export async function currentSession(): Promise<AuthSession | null> {
  try {
    const data = await apiFetch<AuthResponseEnvelope>("/auth/session");
    return extractSession(data);
  } catch {
    return null;
  }
}
