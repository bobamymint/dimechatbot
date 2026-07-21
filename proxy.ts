import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isAllowedAdmin } from "@/lib/auth";

// Protects everything under /admin. Anyone without a valid, allow-listed
// session is redirected to /admin/login. The login page itself is
// excluded so people can actually reach the sign-in form.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  let user = null;
  try {
    const result = await supabase.auth.getUser();
    user = result.data.user;
  } catch (err) {
    // If Supabase is briefly unreachable, fail closed (treat as logged
    // out) instead of taking down the whole /admin section with a 500.
    console.error("proxy auth check failed", err);
  }

  const isLoginPage = request.nextUrl.pathname === "/admin/login";

  if (!isAllowedAdmin(user) && !isLoginPage) {
    return NextResponse.redirect(new URL("/admin/login", request.url));
  }

  if (isAllowedAdmin(user) && isLoginPage) {
    return NextResponse.redirect(new URL("/admin/documents", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/admin/:path*"],
};
