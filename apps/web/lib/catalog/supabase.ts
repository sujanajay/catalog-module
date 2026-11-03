import { supabaseStorageClient, type SupabaseStorageLike } from "@catalog/core/catalog/ingest/supabase-folder";

/**
 * The read-only Supabase Storage client for folder pastes (M1-F1-R4), or null when the paste kind is
 * off: SUPABASE_URL and SUPABASE_SERVICE_KEY (Secret Manager mounts on catalog-web) unset, or
 * SUPABASE_FOLDER_PASTE=off (the admin switch). The key is read from the environment only.
 */
export function supabaseClient(env: NodeJS.ProcessEnv = process.env): SupabaseStorageLike | null {
  if (env.SUPABASE_FOLDER_PASTE === "off" || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  return supabaseStorageClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
}
