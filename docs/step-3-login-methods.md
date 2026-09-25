# Step 3: More ways to sign in

> Status: **Implemented.** The owner approved this design on 2026-09-24, including personal Microsoft accounts as a per-company setting (section 6).
> Date: 2026-09-24. Builds on [architecture.md](architecture.md).

## 1. Decisions from the owner

| Topic                      | Decision                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp provider          | **Meta WhatsApp Cloud API**, behind an adapter so others (MSG91, Twilio, Gupshup) can be added later                                           |
| Fallback                   | If WhatsApp fails or the user asks, the code goes by **email**                                                                                 |
| OTP is used for            | Password-less login, a second factor (2FA), and verifying a mobile number                                                                      |
| Google / Microsoft sign-in | **Invited users only** by default. A company admin can switch on **domain auto-join**, e.g. anyone `@acme.in` joins with a chosen default role |

## 2. What users will see

- **Login page, with three options:**
  1. Email + password (as today)
  2. **Mobile number**: enter company + mobile, get a code on WhatsApp (or "send by email instead"), enter the code
  3. **Continue with Google** / **Continue with Microsoft**
- **My account:**
  - Add a mobile number and verify it with a code.
  - Choose 2FA method: authenticator app, **WhatsApp code** or **email code**.
  - See linked Google/Microsoft accounts and unlink them.
- **Company settings (admin):**
  - Choose which sign-in methods are allowed.
  - Set the allowed email domains for Google/Microsoft.
  - Turn domain auto-join on or off, with its default role and org unit.
  - Optionally require 2FA (as today).

## 3. How it works

### OTP (WhatsApp / email)

- Codes are 6 digits, valid for **5 minutes** and single-use. Only a SHA-256 hash is stored.
- **Limits:**
  - 5 wrong attempts and the code is dead.
  - At most 1 code per 60 seconds and 5 per hour per number.
  - Rate limits per IP at the gateway.
- **Password-less login:** only for users with a **verified** mobile number in that company.
  - The answer never reveals whether a number exists. It always says "if the number is registered, a code was sent".
  - Lockout rules match password login.
- **WhatsApp:** codes are sent with an approved Meta **authentication template** (Meta's rule for OTPs). The template text is in the user's language where one is approved, otherwise English.
- **Mobile numbers** are stored in international format (+91…) and are unique per company.

### Google and Microsoft (OpenID Connect)

- There is one platform-level OAuth app for Google and one for Microsoft (Entra ID, "common", so both work and personal accounts are allowed). Companies don't need their own apps.
- **The flow:** Authorization Code with **PKCE**, plus state and nonce. The provider's ID token is verified against its published keys.
- **Matching a person:**
  1. A linked account (provider + subject id) wins.
  2. Otherwise the provider's **verified** email must match an invited or active user in that company, and the account gets linked.
  3. Otherwise, if domain auto-join is on and the email's domain is allowed, a new user is created with the default role at the default org unit.
  4. Otherwise sign-in is refused.
- After a successful Google/Microsoft sign-in, the user gets the same session as a password login: a 15-minute token and the rotating refresh cookie. If the company requires 2FA, the second factor still applies.
- The company is chosen before redirecting (company URL name), so the same Google account can belong to several companies separately.

### Where it lives

- **identity-service:**
  - OTP challenges
  - verified phone numbers
  - linked accounts
  - OIDC handling
  - the new login endpoints
- **notification-service:**
  - a new **WhatsApp channel** (Meta Cloud API) next to email
  - a **console** channel for development that shows codes in the logs
- **tenant-service:** sign-in policy per company (allowed methods, SSO domains, auto-join settings).
- Every OTP request, success, failure, account link and auto-join is **audited**.

## 4. Configuration you will need to provide (for real delivery)

| For       | What                                                   | Where to get it                                                                                                                    |
| --------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp  | Phone number ID, permanent access token, template name | Meta Business Manager → WhatsApp → API setup; create an **Authentication** template                                                |
| Google    | OAuth client ID + secret                               | Google Cloud Console → Credentials → OAuth client (Web). Redirect URL: `https://<your-domain>/api/v1/identity/sso/google/callback` |
| Microsoft | Application (client) ID + secret                       | Entra ID → App registrations (multi-tenant + personal accounts). Same style of redirect URL                                        |

Until these are set, the console provider (development) and email fallback keep everything testable.

## 5. Step 3 acceptance criteria

1. A user with a verified mobile signs in with a WhatsApp code. With the email fallback, the code arrives by email.
2. Wrong, expired, reused and rate-limited codes are refused, and responses never reveal whether a number is registered.
3. WhatsApp or email codes work as a second factor, and the company 2FA rule is still enforced.
4. Google and Microsoft sign-in work end to end against a test identity provider in automated tests: an invited user is linked, a stranger is refused, and domain auto-join creates a user with the default role only when enabled.
5. The same Google account in two companies gives two separate, isolated sessions.
6. The company admin controls the allowed methods, and a disabled method is refused by the server, not just hidden.
7. All new events are in the audit chain, and CI is green.

## 6. Owner decisions

1. The design above: approved.
2. Personal Microsoft accounts (outlook.com, hotmail): allowed, and **each company admin can switch them off** (`allowPersonalMicrosoft`).

## 7. Implementation notes and known limits

### API

| Endpoint                                                                                  | Purpose                                                                            |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /api/v1/identity/auth/otp/request`                                                  | Send a sign-in code to a verified mobile number (`channel`: `whatsapp` or `email`) |
| `POST /api/v1/identity/auth/otp/verify`                                                   | Exchange `otpToken` + code for a session (or a 2FA step)                           |
| `POST /api/v1/identity/auth/login/mfa/resend`                                             | Send the 2FA code again, or by email instead                                       |
| `GET /api/v1/identity/sso/{google,microsoft}/start?company=`                              | Redirect to Google/Microsoft                                                       |
| `GET /api/v1/identity/sso/{google,microsoft}/callback`                                    | Provider returns here; the browser goes on to `/sso/complete#…`                    |
| `POST /api/v1/identity/me/phone`, `POST …/me/phone/verify`, `DELETE …/me/phone`           | Add, verify or remove the mobile number                                            |
| `POST /api/v1/identity/me/mfa/otp/setup`, `POST …/mfa/otp/enable`, `POST …/mfa/code`      | WhatsApp/email 2FA: turn on, and get a code to turn it off                         |
| `GET /api/v1/identity/me/linked-accounts`, `DELETE …/:id`, `POST /me/sso/{provider}/link` | Linked Google/Microsoft accounts                                                   |
| `GET`/`PUT /api/v1/tenants/current/login-policy`                                          | The company's sign-in policy (`tenant.settings.read` / `update`)                   |

### Rules as built

- **Two factors must differ.** After a WhatsApp/email code sign-in, only the authenticator app counts as the second factor. Users whose 2FA is itself a WhatsApp or email code must sign in with their password.
- **Rate limits.** At most 5 codes per hour per number or user. A new code can be requested 60 seconds after the last one, unless the last one was already used. The gateway's per-IP limits for sign-in endpoints also cover the new endpoints.
- **Lockout.** 5 wrong codes kill the code, and they count towards the same account lockout as wrong passwords.
- **Results in the URL fragment.** SSO results go to `/sso/complete#…`, so tokens never reach server logs. The refresh cookie is set on the callback response.
- **Auto-join.** The role is assigned in access-service first, then the user is created, so a user never exists without access.
- **Unlinking.** Removing the last linked account is refused when the user has no password and no mobile number.

### Configuration

| Service              | Settings                                                                                                                                                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity-service     | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`. Optional: `GOOGLE_ISSUER`, `MICROSOFT_ISSUER` (tests use a fake provider), `SSO_CALLBACK_BASE_URL` (defaults to `APP_URL`)                                                                                          |
| notification-service | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_OTP_TEMPLATE` (default `otp_code`), `WHATSAPP_TEMPLATE_LANGUAGES` (e.g. `en_US,hi,ar`), `WHATSAPP_OTP_BUTTON` (default `true`, for templates with a copy-code button), `WHATSAPP_PROVIDER` (`meta`, `console` for development only, or `disabled`) |

When a provider is not configured, its button shows a clear "not set up on this server" message. Without WhatsApp settings, production runs with WhatsApp `disabled`, and users can still get codes by email.

### Known limits

| Area                             | Behaviour today                                                                   | Planned                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| WhatsApp delivery status         | A send counts as done when Meta accepts it. Undelivered messages are not tracked. | Meta webhooks for delivery status, and automatic email fallback on failure.        |
| Other WhatsApp/SMS providers     | Only the Meta Cloud API.                                                          | MSG91, Gupshup and Twilio adapters behind the same interface.                      |
| SAML and company-owned OIDC apps | One platform-level Google app and one Microsoft app.                              | Per-company SAML / OIDC (Okta, Entra ID tenant-only) with the enterprise features. |
| Error messages                   | Server messages are in English; the login page translates the SSO error codes.    | Translated server messages.                                                        |
| Phone numbers                    | Validated as E.164 format only.                                                   | Country-aware validation (libphonenumber).                                         |
