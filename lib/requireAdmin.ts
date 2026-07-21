import { createClient } from "@/lib/supabase/server";
import { isAllowedAdmin } from "@/lib/auth";

/**
 * Verifies the current request comes from a logged-in, allow-listed
 * admin. Use at the top of every /api/admin/* route handler before
 * touching the database with the service-role client.
 */
export async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAllowedAdmin(user)) {
    return { ok: false as const };
  }

  return { ok: true as const, user };
}
