# Supabase setup

BizBuddy keeps its current local demo path and adds an optional authenticated cloud path. The browser continues to use the existing keys `bizbuddy-data` and `bizbuddy-assistant-chat` for local demo mode and migration source data.

## Configure a Supabase project

1. Create a Supabase project on the free tier or a plan that fits your use.
2. In the Supabase SQL Editor, run [`supabase/migrations/202610240001_bizbuddy_cloud.sql`](supabase/migrations/202610240001_bizbuddy_cloud.sql). This creates `business_profiles`, `customers`, `products`, and `app_settings`, enables row-level security, and installs account-scoped save and insert-only migration functions.
3. In Supabase Authentication settings, enable email/password sign-in and configure the site URL plus allowed redirect URLs for local development and your deployed app. Email confirmation can be enabled; users will be asked to confirm before they can sign in.
4. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from the Supabase project API settings. Use the anon/publishable key only. The matching name is also accepted in newer Supabase projects as the publishable key.
5. Restart Vite after changing environment variables. Deploy the same two `VITE_` values through your hosting provider's frontend environment settings.

Vite embeds `VITE_` values in browser assets. That is expected for the project URL and anon/publishable key; the database is protected by Supabase Auth and RLS. **Never use a service-role key, database password, or other secret in a `VITE_` variable or frontend source.** The SQL functions run as the signed-in caller (`SECURITY INVOKER`) and require the authenticated role.

## Auth and data behavior

- Without both environment variables, the app is labeled **Local demo** and existing localStorage behavior continues.
- With both configured, all app pages are private behind email/password sign-in. Supabase persists and refreshes the browser session.
- A new cloud account that finds existing BizBuddy localStorage data pauses at a choice screen. The user can copy it into an empty cloud account or start with blank cloud data. Local source keys are never cleared by migration.
- Migration calls `migrate_bizbuddy_data`, which checks every target table inside one database transaction and aborts if any account record exists. It never upserts over existing cloud data. If the account already has data, the app loads cloud data and leaves the local copy separate.
- After choosing or loading a cloud workspace, edits save through `save_bizbuddy_data` as an atomic account-scoped snapshot. RLS limits table reads and writes to `auth.uid()`.
- Settings > Clear all local data clears only the local browser copy when signed into Cloud mode; it does not clear the cloud account. In Local demo mode it retains its existing clear-all behavior.

## SDK delivery

The official `@supabase/supabase-js` v2 client (pinned to 2.117.3) is loaded on demand from `https://esm.sh` only when both settings are present; no SDK request is made in local demo mode. Cloud mode therefore needs browser access to that CDN and to the Supabase project. The production bundle does not include the SDK today, so verify the CDN is reachable under your deployment's network and content-security policy. Bundling the package from npm would remove this runtime CDN dependency.

## Current storage mapping

| Existing app data | Supabase table / column |
| --- | --- |
| `bizbuddy-data.business` | `business_profiles.profile` |
| `bizbuddy-data.customers[]` | `customers.data` rows, keyed by existing customer ID |
| `bizbuddy-data.products[]` | `products.data` rows, keyed by existing product ID |
| `bizbuddy-data.poster`, `assistantInstructions`, and `bizbuddy-assistant-chat` | `app_settings.settings` JSON |

Business profiles and settings use the authenticated user's UUID as their primary key. Product/customer IDs remain text to preserve current local records without a destructive ID rewrite.
