// The official supabase-js v2 package is loaded only when cloud mode is enabled.
// This keeps the local demo build usable without adding a runtime requirement.
const url = import.meta.env.VITE_SUPABASE_URL?.trim().replace(/\/$/, "") || "";
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || "";

export const supabaseConfigured = Boolean(url && anonKey);
export const supabasePartiallyConfigured = Boolean(url || anonKey) && !supabaseConfigured;

let clientPromise;
const SDK_LOAD_TIMEOUT_MS = 12_000;
const CLOUD_REQUEST_TIMEOUT_MS = 20_000;

export function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

export function getSupabaseClient() {
  if (!supabaseConfigured) throw new Error("Add both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable cloud mode.");
  if (!clientPromise) {
    const sdkLoad = import(/* @vite-ignore */ "https://esm.sh/@supabase/supabase-js@2.117.3")
      .then(({ createClient }) => createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      }));
    clientPromise = withTimeout(sdkLoad, SDK_LOAD_TIMEOUT_MS, "The Supabase SDK request timed out.")
      .catch((error) => {
        clientPromise = undefined;
        throw new Error(`Supabase client could not be loaded. Check the network connection and retry. ${error instanceof Error ? error.message : ""}`.trim());
      });
  }
  return clientPromise;
}

export async function readCloudData(client, emptyData) {
  const [profileResult, customersResult, productsResult, settingsResult] = await withTimeout(Promise.all([
    client.from("business_profiles").select("profile").maybeSingle(),
    client.from("customers").select("id, data").order("created_at", { ascending: false }),
    client.from("products").select("id, data").order("created_at", { ascending: false }),
    client.from("app_settings").select("settings").maybeSingle(),
  ]), CLOUD_REQUEST_TIMEOUT_MS, "Loading your cloud workspace timed out. Check your connection and retry.");
  for (const result of [profileResult, customersResult, productsResult, settingsResult]) {
    if (result.error) throw result.error;
  }
  const settings = settingsResult.data?.settings || {};
  const data = {
    ...emptyData,
    business: { ...emptyData.business, ...(profileResult.data?.profile || {}) },
    customers: (customersResult.data || []).map((row) => row.data),
    products: (productsResult.data || []).map((row) => row.data),
    poster: { ...emptyData.poster, ...(settings.poster || {}) },
    assistantInstructions: typeof settings.assistantInstructions === "string" ? settings.assistantInstructions : "",
  };
  const chatHistory = Array.isArray(settings.chatHistory) ? settings.chatHistory : [];
  return { data, chatHistory, hasData: Boolean(profileResult.data || customersResult.data?.length || productsResult.data?.length || settingsResult.data) };
}

export async function saveCloudData(client, data, chatHistory) {
  const { error } = await withTimeout(client.rpc("save_bizbuddy_data", {
    p_payload: {
      business: data.business,
      customers: data.customers,
      products: data.products,
      settings: { poster: data.poster, assistantInstructions: data.assistantInstructions || "", chatHistory: chatHistory.slice(-50) },
    },
  }), CLOUD_REQUEST_TIMEOUT_MS, "Saving your cloud workspace timed out. Check your connection and retry.");
  if (error) throw error;
}

export async function migrateLocalData(client, data, chatHistory) {
  const { error } = await withTimeout(client.rpc("migrate_bizbuddy_data", {
    p_payload: {
      business: data.business,
      customers: data.customers,
      products: data.products,
      settings: { poster: data.poster, assistantInstructions: data.assistantInstructions || "", chatHistory: chatHistory.slice(-50) },
    },
  }), CLOUD_REQUEST_TIMEOUT_MS, "Copying your local data timed out. Check your connection and retry.");
  if (error) throw error;
}
