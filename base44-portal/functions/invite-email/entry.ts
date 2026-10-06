import { createClientFromRequest } from "npm:@base44/sdk";

/**
 * The portal's two account emails, sent for the admin console: the invitation (`invite`) and the
 * setup instructions for an account the admin created with a password (`setup`).
 *
 * They have to be sent from here. Base44 refuses `Core.SendEmail` from the browser ("blocked from
 * direct app-runtime calls"), whoever is signed in, so the console's direct calls always failed and
 * every invite fell back to Base44's own invitation — whose only link is the home page. Sent with
 * the service role from a function, it reaches an address that has never signed up, because the
 * app is on a paid plan with its own verified domain.
 *
 * Templated on purpose: the console sends a kind and an address, never a subject, body or link. A
 * compromised admin page can therefore send nothing but these two emails, and they only ever point
 * at this site. The same Base44 `admin` role the `staff` function requires is required here.
 */

const APP_NAME = "DOT Analytics";
/** Where every link points — the published portal, whichever host the admin is working on. */
const PORTAL_URL = "https://analytics.dotaudiences.com";
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

type Kind = "invite" | "setup";
interface Input {
  kind: Kind;
  email: string;
  name: string | null;
  password: string | null;
}

const fail = (status: number, code: string, message: string) =>
  Response.json({ ok: false, error: { code, message } }, { status });

/** Anything a person typed (name, address, password) goes into HTML, so it is escaped first. */
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `SendEmail` delivers the body as HTML, so line breaks have to be paragraphs. */
function html(paragraphs: string[], button: { href: string; label: string }): string {
  const p = (s: string) => `<p style="margin:0 0 14px;font:15px/1.5 Arial,sans-serif;color:#1f1f29">${s}</p>`;
  const [first, ...rest] = paragraphs;
  return [
    p(first),
    `<p style="margin:22px 0"><a href="${button.href}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#2b1a6b;color:#ffffff;font:600 15px Arial,sans-serif;text-decoration:none">${button.label}</a></p>`,
    ...rest.map(p),
  ].join("");
}

function compose({ kind, email, name, password }: Input): { subject: string; body: string } {
  const hello = `Hi ${name ? escape(name) : "there"},`;
  const who = escape(email);
  const login = `<a href="${PORTAL_URL}/login">${PORTAL_URL.replace("https://", "")}/login</a>`;

  if (kind === "invite") {
    const setup = `${PORTAL_URL}/register?email=${encodeURIComponent(email)}`;
    return {
      subject: `You're invited to ${APP_NAME}`,
      body: html(
        [
          `${hello}<br><br>You've been given access to the ${APP_NAME} client portal, where you can follow your advertising results. Setting up your account takes a minute:`,
          `1. Choose a password, or click <b>Continue with Google</b> if ${who} is a Google account.<br>2. Enter the 6-digit code we email you to confirm your address.`,
          `Already have an account with ${who}? Sign in at ${login} — and if you've forgotten the password, click <b>Forgot password?</b> there.`,
          `If the button doesn't work, open this link: <a href="${setup}">${escape(setup)}</a>`,
        ],
        { href: setup, label: "Set up your account" },
      ),
    };
  }

  const activate = `${PORTAL_URL}/activate?email=${encodeURIComponent(email)}`;
  return {
    subject: `Activate your ${APP_NAME} account`,
    body: html(
      [
        `${hello}<br><br>Your ${APP_NAME} client portal account has been created. It needs activating once, which takes a minute:`,
        `1. Enter the 6-digit code from the separate email we sent you. If you can't find it or it has expired, click <b>Email me a new code</b> on that page.<br>2. Enter ${password ? `your password: <b>${escape(password)}</b>` : "the password you were given"}.`,
        `After that, sign in any time at ${login} with ${who} and your password.`,
        `If the button doesn't work, open this link: <a href="${activate}">${escape(activate)}</a>`,
      ],
      { href: activate, label: "Activate your account" },
    ),
  };
}

function parse(raw: unknown): Input | string {
  if (!raw || typeof raw !== "object") return "Send a JSON object.";
  const r = raw as Record<string, unknown>;
  if (r.kind !== "invite" && r.kind !== "setup") return 'kind must be "invite" or "setup".';
  const email = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) return "A valid email address is required.";
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 100) : null;
  const password =
    r.kind === "setup" && typeof r.password === "string" && r.password ? r.password.slice(0, 200) : null;
  return { kind: r.kind, email, name, password };
}

export default async function (req: Request): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "POST only.");

  // `auth.me()` throws rather than returning null — see the note in portal/entry.ts.
  let user: { email?: string | null; role?: string | null } | null = null;
  try {
    user = await createClientFromRequest(req).auth.me();
  } catch (e) {
    return fail(401, "unauthorized", `Not signed in — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!user?.email) return fail(401, "unauthorized", "Sign in first.");
  // Fail closed on an absent role: a missing field must never read as "admin".
  if (user.role !== "admin") return fail(403, "forbidden", "Admin access required.");

  let input: Input | string;
  try {
    input = parse(await req.json());
  } catch {
    input = "Send a JSON object.";
  }
  if (typeof input === "string") return fail(400, "bad_request", input);

  const { subject, body } = compose(input);
  try {
    await createClientFromRequest(req).asServiceRole.integrations.Core.SendEmail({
      to: input.email,
      subject,
      body,
      from_name: APP_NAME,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[invite-email] ${input.kind} to ${input.email} failed:`, message);
    return fail(502, "send_failed", message);
  }
  console.log(`[invite-email] ${input.kind} sent to ${input.email} by ${user.email}`);
  return Response.json({ ok: true });
}
