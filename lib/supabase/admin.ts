import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Privileged Supabase client using the SERVICE ROLE key. This bypasses
// Row Level Security, so it must only ever be imported from server-side
// code (API routes / route handlers) that has already verified the
// caller is an authenticated, allow-listed admin. Never import this
// file from a Client Component.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
}
