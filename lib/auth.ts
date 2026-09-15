// Threads-area auth, ported from main.py. Cookie value must equal the
// configured password; keep the cookie name stable so existing sessions
// survive the migration.

export const THREADS_AUTH_COOKIE = "voz_review_threads_auth";

export function threadsPassword(): string {
  return process.env.THREADS_PASSWORD || "rin2401";
}

export function isThreadsAuthed(cookieValue: string | undefined | null): boolean {
  return cookieValue === threadsPassword();
}
