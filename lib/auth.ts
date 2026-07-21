import type { User } from "@supabase/supabase-js";

// Only emails in ADMIN_EMAILS are allowed to use the admin panel, even
// though anyone could technically sign up in Supabase Auth. This keeps
// setup simple (no invite system) while still restricting write access
// to the knowledge base to you.
export function isAllowedAdmin(user: User | null | undefined): boolean {
  if (!user?.email) return false;
  const allowed = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(user.email.toLowerCase());
}
