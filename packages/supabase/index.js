"use strict";
/**
 * Supabase Client Configuration
 * Centralized Supabase client for the monorepo
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.storage = exports.supabaseAdmin = exports.supabase = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('Supabase credentials not fully configured');
}
// Client for user-facing operations (with anon key)
exports.supabase = (0, supabase_js_1.createClient)(supabaseUrl, supabaseAnonKey, {
    auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
    },
});
// Admin client for server-side operations (with service role key)
exports.supabaseAdmin = supabaseServiceRoleKey
    ? (0, supabase_js_1.createClient)(supabaseUrl, supabaseServiceRoleKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    })
    : null;
// Storage client
exports.storage = exports.supabase.storage;
//# sourceMappingURL=index.js.map