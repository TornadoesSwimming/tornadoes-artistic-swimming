import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token || token === authHeader) return json({ error: "Authentication required" }, 401);

    const url = Deno.env.get("SUPABASE_URL");
    const secretRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
    const secretKey = secretRaw ? JSON.parse(secretRaw)["default"] : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const publicRaw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    const anonKey = publicRaw ? JSON.parse(publicRaw)["default"] : Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !secretKey || !anonKey) return json({ error: "Server authentication is not configured" }, 500);

    const callerClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: callerData, error: callerError } = await callerClient.auth.getUser(token);
    if (callerError || !callerData.user) return json({ error: "Invalid session" }, 401);
    const caller = callerData.user;
    const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "activate_my_access") {
      if (!caller.email || !caller.email_confirmed_at) return json({ error: "Confirm your email address before activating family access" }, 403);
      const email = caller.email.trim().toLowerCase();
      const { data: pendingLinks, error: pendingError } = await admin.from("artistic_guardian_access")
        .select("id,athlete_id").eq("guardian_user_id", caller.id).eq("access_status", "pending");
      if (pendingError) throw pendingError;
      const activated: string[] = [];
      for (const link of pendingLinks || []) {
        const { data: athlete, error: profileError } = await admin.from("artistic_athlete_profiles")
          .select("id,mother_email,father_email").eq("id", link.athlete_id).maybeSingle();
        if (profileError) throw profileError;
        const allowed = [athlete?.mother_email, athlete?.father_email].filter(Boolean)
          .some((value: string) => value.trim().toLowerCase() === email);
        if (!allowed) continue;
        const { error: updateError } = await admin.from("artistic_guardian_access")
          .update({ access_status: "active" }).eq("id", link.id)
          .eq("guardian_user_id", caller.id).eq("access_status", "pending");
        if (updateError) throw updateError;
        activated.push(link.athlete_id);
      }
      return json({ success: true, activated_count: activated.length,
        message: activated.length ? "Family access activated." : "No pending family access matched this confirmed email address." });
    }

    if (action !== "invite") return json({ error: "Unsupported action" }, 400);
    const { data: staff, error: staffError } = await admin.from("artistic_portal_staff")
      .select("role,is_active").eq("user_id", caller.id).maybeSingle();
    if (staffError) throw staffError;
    if (!staff || staff.role !== "admin" || staff.is_active !== true) {
      return json({ error: "Only an active Hub administrator can manage family invitations" }, 403);
    }

    const athleteId = String(body.athlete_id || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    if (!athleteId || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "A valid athlete and parent email are required" }, 400);
    }
    const { data: athlete, error: athleteError } = await admin.from("artistic_athlete_profiles")
      .select("id,full_name,mother_email,father_email").eq("id", athleteId).eq("is_active", true).maybeSingle();
    if (athleteError) throw athleteError;
    if (!athlete) return json({ error: "Active athlete profile not found" }, 404);
    const approvedEmails = [athlete.mother_email, athlete.father_email].filter(Boolean)
      .map((value: string) => value.trim().toLowerCase());
    if (!approvedEmails.includes(email)) return json({ error: "This email does not match a parent email registered on the athlete profile" }, 403);

    const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: "https://tornadoes-artistic-swimming.vercel.app",
      data: { portal: "tornadoes_artistic_swimming" },
    });
    if (inviteError) {
      if (/already|registered|exists/i.test(inviteError.message || "")) {
        return json({ error: "This email already has a Supabase account. Use the secure sign-in link for that account; do not send a new invitation.", existing_account: true }, 409);
      }
      throw inviteError;
    }
    const invitedUserId = inviteData.user?.id;
    if (!invitedUserId) return json({ error: "Invitation was sent but Supabase did not return a user ID. Contact the administrator before retrying." }, 500);

    const { error: linkError } = await admin.from("artistic_guardian_access").upsert({
      guardian_user_id: invitedUserId, athlete_id: athlete.id, access_status: "pending",
    }, { onConflict: "guardian_user_id,athlete_id" });
    if (linkError) return json({ error: "The invitation email was sent, but the pending athlete link could not be saved. Do not resend; contact the administrator.", invitation_sent: true }, 500);

    return json({ success: true, invitation_sent: true, access_status: "pending", athlete_name: athlete.full_name,
      message: "Invitation sent. Athlete access remains blocked until the parent accepts and signs in." });
  } catch (error) {
    console.error("guardian invitation error", error);
    return json({ error: error instanceof Error ? error.message : "Unexpected server error" }, 500);
  }
});