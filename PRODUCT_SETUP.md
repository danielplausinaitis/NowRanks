# Product integrations still requiring owner setup

## Google sign-in

The browser reads only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Do not put a service-role key, `SUPABASE_SECRET_KEY`, provider credentials, or any server secret in a `VITE_` variable.

1. In Supabase Authentication, enable Google and add the Google OAuth client ID and secret created in Google Cloud.
2. Add the local and production callback URLs in both Google Cloud and Supabase. The client redirects to `https://your-domain/#/account` (or the matching local URL).
3. Set the two public Vite variables in the frontend environment.
4. Verify a new account, returning session, sign-out, and an unavailable-provider error before production launch.

## Payments

Premium currently has no checkout. For the web, connect Stripe Checkout and a server-side webhook that records entitlement after verified events. For an Android app, use Google Play Billing for eligible digital subscriptions and synchronize entitlement server-side. Do not trust a browser payment success redirect as entitlement.

## Analytics

`src/analytics/events.ts` defines private, provider-agnostic events: `app_open`, `rankings_view`, `window_changed`, `mode_changed`, `premium_view`, `sign_in_started`, and `sign_in_completed`. It is a no-op until an owner chooses a consent-aware provider. A lightweight privacy-conscious provider or self-hosted analytics is preferable to a new write-heavy product database table. The owner dashboard should eventually report visitors, sessions, page views, ranking views, Premium views, sign-ins, and returning visitors only after the associated collection and privacy notice are implemented.

## Legal review

The Privacy and Terms pages are intentionally MVP templates. The owner must supply the legal entity, contact route, governing-law choice, retention details, and any actual analytics/payment practices before public launch.
