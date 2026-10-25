# Customer Assistant setup

The assistant works in **Local demo** mode without an AI account or network request. To enable AI locally, copy `.env.example` to `.env` and configure an OpenAI-compatible chat-completions endpoint:

```env
AI_API_URL=http://localhost:11434/v1/chat/completions
AI_MODEL=llama3.1
AI_API_KEY=
```

This example is for a local Ollama server with a compatible model installed. It keeps inference on the developer's machine and does not require a hosted AI API key. Local model performance depends on the machine and selected model.

For a hosted provider, use its HTTPS chat-completions endpoint, model identifier, and server-side API key. A hosted provider may charge for usage. Do not prefix these variables with `VITE_` and do not put a secret in frontend code. `.env` is excluded from version control.

For Vercel deployment, configure `AI_API_URL`, `AI_MODEL`, and (for hosted endpoints) `AI_API_KEY` as server environment variables. Production AI requests also require `SUPABASE_URL` and `SUPABASE_ANON_KEY` on the server so the function can verify the signed-in user's access token with Supabase Auth. These are the project URL and public anon/publishable key, not a service-role key. The app sends the current session token to `/api/chat`; the function rejects missing or invalid sessions in production. The `api/chat.js` and `api/status.js` files expose Vercel Node functions, and `vite.config.js` exposes the same handlers during development and preview.

AI requests include the business profile, product catalog, owner instructions, and recent chat messages. The UI labels this mode and the provider key remains on the server. The backend enforces same-origin requests, verified sessions in production, body limits, an in-process per-account request limit, and a provider timeout. Vercel may run multiple function instances, so the in-process limit is not a durable global quota; use provider-side quotas or a shared rate-limit service before exposing a paid AI provider to substantial traffic. The local demo does not call the provider.
