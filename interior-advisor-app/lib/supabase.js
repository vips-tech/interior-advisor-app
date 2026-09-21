const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const isConfigured = Boolean(supabaseUrl && supabaseKey && supabaseUrl !== 'https://placeholder.supabase.co');

if (!isConfigured) {
  console.warn('Supabase env vars are missing. Set SUPABASE_URL and SUPABASE_SECRET_KEY or SUPABASE_PUBLISHABLE_KEY before uploading files.');
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder-key', {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

supabase.isConfigured = isConfigured;
module.exports = supabase;