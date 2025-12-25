/*
=====================================================
⚠️ IMPORTANT: RUN THIS SQL IN SUPABASE SQL EDITOR FIRST!
=====================================================

-- 1. Create profiles table
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  onboarding_completed boolean default false,
  last_login timestamp with time zone,
  created_at timestamp with time zone default now()
);
alter table public.profiles enable row level security;
create policy "Users can view own profile" on profiles for select using ((select auth.uid()) = id);
create policy "Users can update own profile" on profiles for update using ((select auth.uid()) = id);
create policy "Users can insert own profile" on profiles for insert with check ((select auth.uid()) = id);

-- 2. Create or Update prompt_saves table
create table if not exists public.prompt_saves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  device_id text,
  client_mutation_id text unique,
  title text,
  body text,
  tags text,
  category text,
  favorite boolean default false,
  total_usage integer default 0,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Ensure columns are TEXT and exist (Idempotent Migration)
do $$
begin
  -- Rename prompt_text to body if it exists and body prevents clean setup
  if exists (select 1 from information_schema.columns where table_name = 'prompt_saves' and column_name = 'prompt_text') then
     alter table public.prompt_saves rename column prompt_text to body;
  end if;
  
  -- Add usage tracking columns if they don't exist
  if not exists (select 1 from information_schema.columns where table_name = 'prompt_saves' and column_name = 'total_usage') then
     alter table public.prompt_saves add column total_usage integer default 0;
  end if;
  
  if not exists (select 1 from information_schema.columns where table_name = 'prompt_saves' and column_name = 'last_used_at') then
     alter table public.prompt_saves add column last_used_at timestamp with time zone;
  end if;

  if not exists (select 1 from information_schema.columns where table_name = 'prompt_saves' and column_name = 'updated_at') then
     alter table public.prompt_saves add column updated_at timestamp with time zone default now();
  end if;

  if not exists (select 1 from information_schema.columns where table_name = 'prompt_saves' and column_name = 'client_mutation_id') then
     alter table public.prompt_saves add column client_mutation_id text;
     alter table public.prompt_saves add constraint prompt_saves_client_mutation_id_key unique (client_mutation_id);
  end if;

  if not exists (select 1 from information_schema.columns where table_name = 'prompt_saves' and column_name = 'folder_id') then
     alter table public.prompt_saves add column folder_id uuid references public.folders(id) on delete set null;
  end if;
end $$;

-- 3. Create device_metadata table
create table if not exists public.device_metadata (
  device_id text primary key,
  categories text,
  updated_at timestamp with time zone default now()
);

-- 4. Create tags table
create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  created_at timestamp with time zone default now()
);

-- 5. Enable RLS
alter table public.prompt_saves enable row level security;
alter table public.device_metadata enable row level security;
alter table public.tags enable row level security;

-- 6. RLS Policies (Safe drop/recreate sequence)
drop policy if exists "Enable all access for devices" on prompt_saves;
drop policy if exists "Users and Devices can manage their own prompts" on prompt_saves;
drop policy if exists "Devices can manage metadata" on device_metadata;
drop policy if exists "Allow public read access to tags" on tags;

-- Now safe to alter columns
alter table public.prompt_saves 
  alter column device_id type text,
  alter column body type text,
  alter column tags type text,
  alter column category type text;

alter table public.device_metadata alter column device_id type text;

create policy "Users and Devices can manage their own prompts" on prompt_saves
  for all using (
    ((select auth.uid()) = user_id) OR 
    (device_id = (select current_setting('request.headers', true)::json->>'x-device-id')) OR
    ((select auth.role()) = 'anon')
  );

create policy "Devices can manage metadata" on device_metadata
  for all using (
    (device_id = (select current_setting('request.headers', true)::json->>'x-device-id')) OR
    ((select auth.role()) = 'anon')
  );

create policy "Authenticated users can insert tags" on tags
  for insert with check ((select auth.role()) = 'authenticated');

create policy "Allow public read access to tags" on tags
  for select using (true);


-- 6. Folder System Support
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id), -- Nullable for Guest Mode
  device_id text,                         -- Added for Guest Mode
  name text not null,
  created_at timestamp with time zone default now()
);

-- RLS for Folders
alter table public.folders enable row level security;

create policy "Users and Devices can view own folders" on folders
  for select using (
    ((select auth.uid()) = user_id) OR 
    (device_id = (select current_setting('request.headers', true)::json->>'x-device-id')) OR
    ((select auth.role()) = 'anon')
  );

create policy "Users and Devices can create own folders" on folders
  for insert with check (
    ((select auth.uid()) = user_id) OR 
    (device_id = (select current_setting('request.headers', true)::json->>'x-device-id')) OR
    ((select auth.role()) = 'anon')
  );

create policy "Users and Devices can update own folders" on folders
  for update using (
    ((select auth.uid()) = user_id) OR 
    (device_id = (select current_setting('request.headers', true)::json->>'x-device-id')) OR
    ((select auth.role()) = 'anon')
  );

create policy "Users and Devices can delete own folders" on folders
  for delete using (
    ((select auth.uid()) = user_id) OR 
    (device_id = (select current_setting('request.headers', true)::json->>'x-device-id')) OR
    ((select auth.role()) = 'anon')
  );

-- Add folder_id to prompt_saves (Handled in main migration block)


-- 7. Shared Prompts (Immutable Link Snapshots)
create table if not exists public.shared_prompts (
  id uuid primary key default gen_random_uuid(),
  short_code text unique not null,
  original_author_id uuid references auth.users(id),
  content_snapshot jsonb not null,
  views integer default 0,
  created_at timestamp with time zone default now()
);

-- RLS for Shared Prompts
alter table public.shared_prompts enable row level security;

-- Public Read Access (For recipients)
create policy "Allow public read access to shared prompts" on shared_prompts
  for select using (true);

-- Authenticated/Guest Creation Access (For senders)
create policy "Allow creation of shared prompts" on shared_prompts
  for insert with check (true);

-- Only Author Can Delete (Revoke)
create policy "Users can delete their own shared links" on shared_prompts
  for delete using (((select auth.uid()) = original_author_id));


-- 8. Performance Indexes (Linter Fixes)
-- Foreign Keys
create index if not exists idx_folders_user_id on public.folders(user_id);
create index if not exists idx_prompt_saves_user_id on public.prompt_saves(user_id);
create index if not exists idx_prompt_saves_folder_id on public.prompt_saves(folder_id);
create index if not exists idx_shared_prompts_original_author_id on public.shared_prompts(original_author_id);

-- Performance columns (used in RLS)
create index if not exists idx_folders_device_id on public.folders(device_id);
create index if not exists idx_prompt_saves_device_id on public.prompt_saves(device_id);
create index if not exists idx_device_metadata_device_id on public.device_metadata(device_id);

=====================================================
*/

// ---------- Init & Globals ----------
if (typeof nlp !== 'undefined' && typeof nlpDates !== 'undefined') {
  nlp.extend(nlpDates);
}
// Globals for Template Flow
let lastPendingPrompt = null;
let selectedVariableWords = new Set();

const SUPABASE_URL = window.SUPABASE_URL;
const SUPABASE_KEY = window.SUPABASE_ANON_KEY;
let supabaseClient = null;
let device_id = localStorage.getItem('device_id');
let user_session = null;

// Validate/Generate Device ID
if (!device_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(device_id)) {
  device_id = crypto.randomUUID();
  localStorage.setItem('device_id', device_id);
}

// Categories
const DEFAULT_CATEGORIES = ['coding', 'writing', 'art', 'other'];
let categories = [];
try { categories = JSON.parse(localStorage.getItem('categories') || JSON.stringify(DEFAULT_CATEGORIES)); } catch (e) { categories = DEFAULT_CATEGORIES; }

// Prompts Data
let prompts = [];
try { prompts = JSON.parse(localStorage.getItem('prompts') || '[]'); } catch (e) { console.error('Corrupt Prompts', e); localStorage.removeItem('prompts'); }

// Persisted Sync Queue
let syncQueue = [];
try { syncQueue = JSON.parse(localStorage.getItem('syncQueue') || '[]'); } catch (e) { console.error('Corrupt Queue', e); localStorage.removeItem('syncQueue'); }

let folders = [];
try { folders = JSON.parse(localStorage.getItem('folders') || '[]'); } catch (e) { console.error('Resetting Folders', e); localStorage.removeItem('folders'); }
let activeFolderId = null; // null = 'All Prompts'

let hasManuallySetCategory = false;
let hasManuallySetTitle = false;

console.log("App Start: Parsed Data", {
  prompts_len: prompts.length,
  syncQueue_len: syncQueue.length,
  folders_len: folders.length
});

/**
 * SyncService - Manages background sync operations with idempotency.
 */
class SyncService {
  constructor() {
    this.isProcessing = false;
    this.retryBackoff = 5000; // Start with 5s
  }

  async enqueue(op) {
    // op: { type: 'create'|'update'|'delete', local_id, payload }
    syncQueue.push({ ...op, timestamp: Date.now() });
    saveToLocalStorage();
    this.process();
  }

  async process() {
    if (this.isProcessing || !supabaseClient || syncQueue.length === 0) return;
    this.isProcessing = true;

    while (syncQueue.length > 0) {
      const op = syncQueue[0];
      const success = await this.executeOp(op);

      if (success) {
        syncQueue.shift();
        saveToLocalStorage();
        this.retryBackoff = 5000; // Reset backoff on success
      } else {
        console.warn("Sync failed, will retry later.", op);
        // Exponential backoff or just wait for next trigger
        setTimeout(() => { this.isProcessing = false; }, this.retryBackoff);
        this.retryBackoff = Math.min(this.retryBackoff * 2, 60000); // Max 1 min
        return;
      }
    }
    this.isProcessing = false;
  }

  async executeOp(op) {
    try {
      if (op.type === 'create' || op.type === 'update') {
        // Idempotent upsert using local_id as client_mutation_id
        const { data, error } = await supabaseClient
          .from('prompt_saves')
          .upsert({
            user_id: user_session?.user?.id,
            device_id: device_id,
            title: op.payload.title,
            body: op.payload.body,
            tags: Array.isArray(op.payload.tags) ? op.payload.tags.join(',') : op.payload.tags,
            category: op.payload.category,
            favorite: op.payload.favorite,
            folder_id: op.payload.folder_id,
            client_mutation_id: op.local_id, // Key for idempotency
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'client_mutation_id',
            ignoreDuplicates: false
          })
          .select()
          .single();

        if (error) throw error;

        // Update local mirror state
        const promptIndex = prompts.findIndex(p => p.id === op.local_id);
        if (promptIndex > -1) {
          prompts[promptIndex].cloud_id = data.id;
          prompts[promptIndex].status = 'synced';
          prompts[promptIndex].is_guest_data = false;
          saveToLocalStorage();
          renderPrompts(searchInput?.value, currentFilter);
        }
      } else if (op.type === 'delete') {
        const { error } = await supabaseClient
          .from('prompt_saves')
          .delete()
          .eq('client_mutation_id', op.local_id);

        if (error) throw error;
      }
      return true;
    } catch (err) {
      console.error("Sync Exception:", err);
      // Mark local as error if item still exists
      const p = prompts.find(p => p.id === op.local_id);
      if (p) p.status = 'error';
      return false;
    }
  }

  /**
   * Migrate guest items to cloud
   */
  async migrateGuestData() {
    if (!user_session) return;

    const guestItems = prompts.filter(p => p.is_guest_data);
    if (guestItems.length === 0) return;

    for (const item of guestItems) {
      // Check if already in queue to avoid duplicates
      if (!syncQueue.find(op => op.local_id === item.id)) {
        item.status = 'syncing';
        item.user_id = user_session.user.id;
        this.enqueue({ type: 'create', local_id: item.id, payload: item });
      }
    }
  }
}

const syncService = new SyncService();


if (SUPABASE_URL && SUPABASE_KEY) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { 'x-device-id': device_id } }
  });
} else {
  console.warn("Supabase credentials missing in cloudConfig.js");
}

let isGridExpanded = false;

// ---------- DOM Elements ----------
const grid = document.getElementById('promptGrid');
const fab = document.getElementById('fab');
const modalOverlay = document.getElementById('modalOverlay');
const closeModalBtn = document.getElementById('closeModal');
const promptForm = document.getElementById('promptForm');
const searchInput = document.getElementById('searchInput');
const customCategoryDropdown = document.getElementById('customCategoryDropdown');
const modalCategoryDropdown = document.getElementById('modalCategoryDropdown');
const toast = document.getElementById('toast');
const settingsBtn = document.getElementById('settingsBtn');
const settingsDropdown = document.getElementById('settingsDropdown');
const exportOption = document.getElementById('exportOption');
const importOption = document.getElementById('importOption');
const themeOption = document.getElementById('themeOption');
const fileInput = document.getElementById('fileInput');

// Variable Modal DOM
const variableModalOverlay = document.getElementById('variableModalOverlay');
const variableFields = document.getElementById('variableFields');
const closeVarModalBtn = document.getElementById('closeVarModal');
const copyFinalBtn = document.getElementById('copyFinalBtn');
const varModalTitle = document.getElementById('varModalTitle');

// Template Choice Modal DOM
const templateChoiceOverlay = document.getElementById('templateChoiceOverlay');
const templateChoiceYes = document.getElementById('templateChoiceYes');
const templateChoiceNo = document.getElementById('templateChoiceNo');

// Variable Selection Modal DOM
const varSelectOverlay = document.getElementById('varSelectOverlay');
const varSelectPreview = document.getElementById('varSelectPreview');
const closeVarSelectModalBtn = document.getElementById('closeVarSelectModal');
const confirmVarSelectBtn = document.getElementById('confirmVarSelectBtn');

// Auth DOM
const authOverlay = document.getElementById('authOverlay');
const authEmailForm = document.getElementById('authEmailForm');
const authOtpForm = document.getElementById('authOtpForm');
const emailInput = document.getElementById('emailInput');
const sendOtpBtn = document.getElementById('sendOtpBtn');
const verifyOtpBtn = document.getElementById('verifyOtpBtn');
const otpContainer = document.getElementById('otpContainer');
const otpInputs = document.querySelectorAll('.otp-input');
const backToEmailLink = document.getElementById('backToEmail');
const skipAuthBtn = document.getElementById('skipAuthBtn');
const userInfoOption = document.getElementById('userInfoOption');
const userEmailDisplay = document.getElementById('userEmailDisplay');
const logoutOption = document.getElementById('logoutOption');
const loginOption = document.getElementById('loginOption');

let currentFilter = 'all';

// ---------- App Start ----------
async function initApp() {
  try {
    console.log("initApp: Starting initialization...");
    applyTheme();
    setupAuthListeners();
    setupEventListeners();
    renderCategories();
    renderFolderStream();

    // Data Normalization (One-time migration for legacy objects)
    let needsSave = false;
    prompts.forEach(p => {
      if (p.is_guest_data === undefined) {
        // If it was local and not synced, it's guest data
        p.is_guest_data = !p.cloud_id;
        p.status = p.cloud_id ? 'synced' : 'local-only';
        p.user_id = p.user_id || null;
        needsSave = true;
      }
    });
    if (needsSave) saveToLocalStorage();

    // RENDER FAST: Show local prompts immediately for LCP
    renderPrompts();

    // Check for incoming shared link FIRST (Routing)
    const isSharedView = await checkSharedLink();
    if (isSharedView) {
      console.log("Shared View Active - Halting Main App Init");
      return;
    }

    // Check initial session
    if (supabaseClient) {
      const { data: { session }, error } = await supabaseClient.auth.getSession();
      if (error) console.error("Session fetch error:", error);
      user_session = session;

      if (session) {
        console.log("initApp: Session found for", session.user.email);
        updateAuthUI();
        renderUserProfile(session.user);
        // Sync in background to avoid blocking LCP
        syncData();
      } else {
        console.log("initApp: No session.");
      }

      // Listen for auth changes (Magic Link redirects, logouts, etc.)
      supabaseClient.auth.onAuthStateChange(async (event, session) => {
        console.log("Auth State Changed:", event, session?.user?.email);
        user_session = session;
        if (event === 'SIGNED_IN' && session) {
          updateAuthUI();
          renderUserProfile(session.user);

          // Ensure profile exists in DB
          try {
            await supabaseClient.from('profiles').upsert({
              id: session.user.id,
              email: session.user.email,
              last_login: new Date().toISOString()
            });

            // Always show onboarding after a fresh SIGNED_IN event
            onboardingManager.show();
          } catch (e) { console.warn("Profile sync failed", e); }

          await migratePromptsToUser(session.user.id);
          await syncData();
          hideAuthOverlay();
        } else if (event === 'SIGNED_OUT') {
          user_session = null;
          updateAuthUI();
          renderUserProfile(null);
          renderPrompts();
        }
      });
    } else {
      renderPrompts();
    }
  } catch (err) {
    console.error("Init App Error:", err);
    // Fallback
    renderPrompts();
  }
} // End of initApp definition; removed immediate call (IIFE)

// Debug
// (Moved debug assignments to EOF)

async function syncData() {
  // New unified sync flow
  syncService.process();

  // Sync folders & metadata
  await syncLocalFoldersToCloud();
  await loadCategoriesFromCloud();
  await syncFolders();

  // Merge cloud data (Last Write Wins)
  await loadPromptsFromSupabaseAndMerge();

  setupRealtime();
}

// ---------- Auth Handlers ----------
function setupAuthListeners() {
  // Step 1: Send OTP
  authEmailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;

    setLoading(sendOtpBtn, true);

    // Set explicit intent before starting auth flow
    localStorage.setItem('user_intent_login', 'true');

    // Note: To receive a 6-digit code, ensure 'Enable Email Provider' is ON in Supabase
    // and your email template includes {{ .Token }}
    // Switch to Code Flow (More reliable than Links)
    console.log("Attempting login for:", email);

    // Switch back to Magic Link (User Request)
    console.log("Sending Magic Link to:", email);
    const { data, error } = await supabaseClient.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: window.location.origin
      }
    });

    console.log("Supabase Auth Response:", { data, error });
    setLoading(sendOtpBtn, false);

    if (error) {
      console.error("Auth Error:", error);
      alert('Error sending magic link: ' + error.message);
    } else {
      console.log("Magic Link Sent.");
      authEmailForm.classList.add('hidden');
      authOtpForm.classList.add('hidden'); // Ensure OTP form is hidden
      document.getElementById('sentEmailAddress').textContent = email;
      document.getElementById('authCheckEmail').classList.remove('hidden'); // Show "Check for Link" message
    }
  });

  // ADD THIS: Close button handler
  const closeAuthBtn = document.getElementById('closeAuthBtn');
  if (closeAuthBtn) {
    closeAuthBtn.addEventListener('click', () => {
      hideAuthOverlay();
    });
  }

  // Step 2: Verify OTP
  authOtpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = Array.from(otpInputs).map(input => input.value).join('');
    if (token.length !== 6) return alert('Please enter the full 6-digit code');

    setLoading(verifyOtpBtn, true);

    // Attempt verification. 'email' is the generic generic OTP type for magic links/codes
    const { data: { session }, error } = await supabaseClient.auth.verifyOtp({
      email: emailInput.value,
      token,
      type: 'email'
    });
    setLoading(verifyOtpBtn, false);

    if (error) {
      alert('Login failed: ' + error.message);
    } else if (session) {
      user_session = session;
      sessionStorage.setItem('skipped_auth', 'false'); // Reset skip flag on explicit login

      // Update User Profile
      await supabaseClient.from('profiles').upsert({
        id: session.user.id,
        email: session.user.email,
        last_login: new Date().toISOString()
      });

      hideAuthOverlay();
      showToast(`Welcome, ${session.user.email.split('@')[0]}!`);
      updateAuthUI();
      renderUserProfile(session.user); // Explicit UI Update

      // MIGRATE PROMPTS
      await migratePromptsToUser(session.user.id);

      // Full Re-Sync
      await syncData();
    }
  });

  // OTP Input Logic (Auto-focus)
  otpInputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
      if (e.inputType === 'insertText' && e.target.value) {
        if (index < otpInputs.length - 1) otpInputs[index + 1].focus();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && index > 0) {
        otpInputs[index - 1].focus();
      }
    });

    // Paste support
    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text').trim();
      if (!/^\d+$/.test(text)) return;

      const chars = text.split('');
      otpInputs.forEach((inp, i) => {
        if (chars[i]) inp.value = chars[i];
      });
      // focus last filled
      const lastIdx = Math.min(chars.length, otpInputs.length) - 1;
      if (lastIdx >= 0) otpInputs[lastIdx].focus();
    });
  });

  // Back to Email
  backToEmailLink.addEventListener('click', (e) => {
    e.preventDefault();
    authOtpForm.classList.add('hidden');
    authEmailForm.classList.remove('hidden');
  });

  // Skip (Guest Mode)
  skipAuthBtn.addEventListener('click', () => {
    // Guest mode: do not set skip flag, just hide overlay and sync as guest
    hideAuthOverlay();
    syncData(); // Sync as Guest
  });

  // Login Option (Manual Trigger)
  if (loginOption) {
    loginOption.addEventListener('click', () => {
      showAuthOverlay();
    });
  }

  // Logout
  logoutOption.addEventListener('click', handleLogout);
}

function updateAuthUI() {
  if (user_session) {
    userInfoOption.style.display = 'flex';
    logoutOption.style.display = 'flex';
    if (loginOption) loginOption.style.display = 'none';
    userEmailDisplay.textContent = user_session.user.email;
  } else {
    userInfoOption.style.display = 'none';
    logoutOption.style.display = 'none';
    if (loginOption) loginOption.style.display = 'flex';
  }
}

function showAuthOverlay() {
  authOverlay.classList.remove('hidden');
}

function hideAuthOverlay() {
  authOverlay.classList.add('hidden');
}

function setLoading(btnElement, isLoading) {
  const textSpan = btnElement.querySelector('.btn-text');
  const loader = btnElement.querySelector('.loader');
  if (isLoading) {
    textSpan.classList.add('hidden');
    loader.classList.remove('hidden');
    btnElement.disabled = true;
  } else {
    textSpan.classList.remove('hidden');
    loader.classList.add('hidden');
    btnElement.disabled = false;
  }
}

// ---------- Migration Logic ----------
async function migratePromptsToUser(userId) {
  if (!supabaseClient) return;

  console.log("Starting Migration...");

  // 1. Migrate Local Guest Data
  await syncService.migrateGuestData();

  // 2. Fallback: Server-side migration for orphaned device data
  if (device_id) {
    const { data: devicePrompts, error } = await supabaseClient
      .from('prompt_saves')
      .select('id')
      .eq('device_id', device_id)
      .is('user_id', null);

    if (!error && devicePrompts && devicePrompts.length > 0) {
      const idsToMigrate = devicePrompts.map(p => p.id);
      await supabaseClient
        .from('prompt_saves')
        .update({ user_id: userId })
        .in('id', idsToMigrate);
    }
  }
}


// ---------- Event Listeners ----------
function setupEventListeners() {
  // Fab & Modal
  fab.addEventListener('click', () => {
    openModal();
    if (window.tagManager) window.tagManager.reset(); // Reset tags
    // Animation reset
    fab.classList.remove('pulse-animation');
  });
  closeModalBtn.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // Settings
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsDropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => settingsDropdown.classList.remove('open'));

  // Theme
  themeOption.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    applyTheme(); // Refresh styles if needed
  });

  // Export/Import
  exportOption.addEventListener('click', exportData);
  importOption.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => importDataFile(e.target.files[0]));

  // Auto-fill
  document.getElementById('autoFillBtn').addEventListener('click', () => {
    const bodyVal = document.getElementById('body').value;
    if (!bodyVal) return showToast('Enter a prompt first!');
    const analysis = analyzePrompt(bodyVal);

    // Explicitly update even if manually set (since user clicked the button)
    document.getElementById('title').value = analysis.title;
    updateCategoryDropdownUI(modalCategoryDropdown, analysis.category);
    if (window.tagManager) window.tagManager.reset(analysis.tags);

    hasManuallySetCategory = true;
    hasManuallySetTitle = true;
    showToast(`Detected: ${capitalize(analysis.category)}`);
  });

  // LIVE Auto-detection as user types
  document.getElementById('body').addEventListener('input', (e) => {
    const text = e.target.value.trim();
    if (text.length < 10) return; // Wait for enough context

    const analysis = analyzePrompt(text);

    // Auto-update category if not manually touched
    if (!hasManuallySetCategory) {
      updateCategoryDropdownUI(modalCategoryDropdown, analysis.category);
    }

    // Auto-update title if not manually touched
    if (!hasManuallySetTitle && text.length < 100) {
      const gTitle = autoGenerateTitle(text);
      document.getElementById('title').value = gTitle;
    }
  });

  // Track manual overrides
  document.getElementById('title').addEventListener('input', () => { hasManuallySetTitle = true; });

  // Form Submit
  promptForm.addEventListener('submit', handleFormSubmit);

  // Search
  searchInput.addEventListener('input', (e) => {
    renderPrompts(e.target.value, currentFilter);
  });

  // Quick Add
  document.getElementById('quickAddBtn').addEventListener('click', handleQuickAdd);

  // FAB Hide on Scroll
  let lastScrollY = window.scrollY;
  window.addEventListener('scroll', () => {
    if (window.scrollY > lastScrollY && window.scrollY > 100) {
      fab.classList.add('hide-fab');
    } else {
      fab.classList.remove('hide-fab');
    }
    lastScrollY = window.scrollY;
  });

  // Custom Dropdown Logic
  setupCustomDropdown(customCategoryDropdown, (val) => {
    currentFilter = val;
    renderPrompts(searchInput.value, currentFilter);
  });

  setupCustomDropdown(modalCategoryDropdown, (val) => {
    document.getElementById('category').value = val;
    hasManuallySetCategory = true; // User manually chose something
    // Check if "New Category"
    if (val === 'add_new') {
      const newCat = prompt("Enter new category name:");
      if (newCat) {
        addNewCategory(newCat);
        updateCategoryDropdownUI(modalCategoryDropdown, newCat);
        document.getElementById('category').value = newCat;
      }
    }
  });

  // Folder Dropdown Logic
  setupCustomDropdown(document.getElementById('folderDropdown'), (val) => {
    document.getElementById('folder').value = val;
    // Visual update handled by generic click handler in setupCustomDropdown
    // but we want to ensure text updates correctly for complex HTML options
    // Actually setupCustomDropdown sets textContent = option.textContent, which includes emoji. Good.
  });

  // Quick Paste Enter Key
  document.getElementById('quickPaste').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleQuickAdd();
  });

  // Variable Modal
  if (closeVarModalBtn) {
    closeVarModalBtn.addEventListener('click', () => variableModalOverlay.classList.add('hidden'));
  }
  if (variableModalOverlay) {
    variableModalOverlay.addEventListener('click', (e) => {
      if (e.target === variableModalOverlay) variableModalOverlay.classList.add('hidden');
    });
  }

  // Template Choice Guards
  if (templateChoiceYes) {
    templateChoiceYes.onclick = () => {
      hideTemplateChoiceModal();
      showVariableSelectionModal(lastPendingPrompt);
    };
  }
  if (templateChoiceNo) {
    templateChoiceNo.onclick = () => {
      hideTemplateChoiceModal();
      savePromptFinal(lastPendingPrompt);
    };
  }

  // Row Limitation Toggle
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      isGridExpanded = !isGridExpanded;
      renderPrompts(searchInput.value, currentFilter);
      // Wait for render then scroll slightly if expanding?
      if (isGridExpanded) {
        // Optional: smooth scroll or focus
      }
    });
  }

  // Re-calculate visible rows on resize to keep exactly 3 rows if not expanded
  window.addEventListener('resize', () => {
    if (!isGridExpanded && resultsForResizeCheck > 0) {
      renderPrompts(searchInput.value, currentFilter);
    }
  });
}

function hideTemplateChoiceModal() {
  if (templateChoiceOverlay) templateChoiceOverlay.classList.add('hidden');
}

async function savePromptFinal(promptData) {
  if (!promptData) return;

  // Logic to finalize saving a prompt (already in prompts array, just needs cloud sync and UI refresh)
  saveToLocalStorage();
  renderPrompts();
  hideTemplateChoiceModal();
}

function setupCustomDropdown(dropdownElement, onSelect) {
  const selected = dropdownElement.querySelector('.dropdown-selected');
  const optionsContainer = dropdownElement.querySelector('.dropdown-options');

  selected.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close others
    document.querySelectorAll('.custom-dropdown').forEach(d => {
      if (d !== dropdownElement) d.classList.remove('open');
    });
    dropdownElement.classList.toggle('open');
  });

  // Delegation for dynamic options
  optionsContainer.addEventListener('click', (e) => {
    const option = e.target.closest('.dropdown-option');
    if (!option) return;
    e.stopPropagation();

    const val = option.dataset.value;
    const text = option.textContent;

    if (option.id === 'userInfoOption' || option.id === 'logoutOption' || option.id === 'exportOption' || option.id === 'importOption' || option.id === 'themeOption') {
      // These are actions, not selects
      dropdownElement.classList.remove('open');
      return;
    }

    selected.textContent = text;
    dropdownElement.classList.remove('open');

    // Visual selection
    dropdownElement.querySelectorAll('.dropdown-option').forEach(o => o.classList.remove('selected'));
    if (val !== 'add_new') option.classList.add('selected');

    if (onSelect) onSelect(val);
  });

  document.addEventListener('click', () => dropdownElement.classList.remove('open'));
}

function updateCategoryDropdownUI(dropdownElement, value) {
  const selected = dropdownElement.querySelector('.dropdown-selected');
  const options = dropdownElement.querySelectorAll('.dropdown-option');

  // Find matching text
  let matchedText = value;
  options.forEach(opt => {
    if (opt.dataset.value === value) {
      matchedText = opt.textContent;
      opt.classList.add('selected');
    } else {
      opt.classList.remove('selected');
    }
  });

  selected.textContent = matchedText;
  document.getElementById('category').value = value;
}


// Custom Lexicon for Accuracy Booster
const LEXICON_BOOST = {
  // Names
  'aarav': 'Person', 'amara': 'Person', 'ankita': 'Person', 'chen': 'Person', 'diego': 'Person',
  'hiroshi': 'Person', 'kenji': 'Person', 'mateo': 'Person', 'priya': 'Person', 'santiago': 'Person',
  'zara': 'Person', 'liam': 'Person', 'sofia': 'Person', 'hans': 'Person', 'fatima': 'Person',
  // Orgs
  'spacex': 'Organization', 'openai': 'Organization', 'microsoft': 'Organization', 'apple': 'Organization',
  'google': 'Organization', 'tesla': 'Organization', 'facebook': 'Organization', 'meta': 'Organization'
};

const STOPWORDS_LITE = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'in', 'on', 'at', 'to', 'for', 'with', 'by', 'about', 'against', 'between', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'from', 'up', 'down', 'of', 'off', 'over', 'under',
  'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any',
  'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now',
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 'yourself',
  'it', 'its', 'itself', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself'
]);

function autoConvertVariables(text) {
  if (!text) return text;

  // 1. Convert [...] and <...> (Explicit markers)
  let newText = text.replace(/\[([^\]]+)\]/g, '{{$1}}');
  newText = newText.replace(/<([^>]+)>/g, '{{$1}}');

  if (typeof nlp === 'undefined') return newText;

  try {
    // Apply Booster Lexicon
    const doc = nlp(newText, LEXICON_BOOST);

    // 2. NLP Detect Names, Places, Orgs, Dates
    const matches = [
      { list: (doc.people && typeof doc.people === 'function') ? doc.people() : doc.match('#Person'), cat: '{{name}}', min: 2 },
      { list: (doc.places && typeof doc.places === 'function') ? doc.places() : doc.match('#Place'), cat: '{{location}}', min: 2 },
      { list: (doc.organizations && typeof doc.organizations === 'function') ? doc.organizations() : doc.match('#Organization'), cat: '{{organization}}', min: 3 },
      { list: (doc.dates && typeof doc.dates === 'function') ? doc.dates() : doc.match('#Date'), cat: '{{date}}', min: 4 }
    ];

    matches.forEach(m => {
      m.list.forEach(match => {
        const val = match.text('normal');
        if (val.length >= m.min) {
          const re = new RegExp(`\\b${val.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`, 'gi');
          newText = newText.replace(re, m.cat);
        }
      });
    });

    // 3. Smart Capitalization Fallback (Catch missed entities)
    // Splits by spaces/punctuation to find capitalized words
    const words = newText.split(/(\s+|[.,!?;:"'()[\]{}])/g);
    let result = [];

    words.forEach((word, i) => {
      // If it's a word (not space/punct), starts with uppercase, and isn't a common stopword
      const cleanWord = word.replace(/[.,!?;:"'()[\]{}]/g, '');
      if (cleanWord.length > 2 && /^[A-Z]/.test(cleanWord)) {
        const lower = cleanWord.toLowerCase();

        // Safety: Check if it's NOT at the start of a sentence-like segment
        const isStart = (i === 0 || words[i - 1].includes('.') || words[i - 1].includes('\n'));
        const isStopword = STOPWORDS_LITE.has(lower);

        if (!isStopword && !isStart) {
          result.push('{{name}}'); // Fallback to generic name/entity
          return;
        }
      }
      result.push(word);
    });

    newText = result.join('');
    return newText;
  } catch (err) {
    console.error("NLP Error:", err);
    return newText;
  }
}

// ---------- CRUD Logic ----------

async function handleFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('promptId').value;
  const title = document.getElementById('title').value;
  const category = document.getElementById('category').value || 'other';
  let body = document.getElementById('body').value;

  const tags = document.getElementById('tags').value.split(',').map(t => t.trim()).filter(Boolean);

  // Robustly find existing prompt
  let existingPrompt = null;
  if (id) {
    existingPrompt = prompts.find(p => String(p.id) === String(id));
  }

  const promptData = {
    id: id || crypto.randomUUID(),
    title: title || autoGenerateTitle(body),
    category,
    body,
    tags,
    date: existingPrompt ? existingPrompt.date : new Date().toISOString(),
    updated_at: new Date().toISOString(),
    favorite: existingPrompt ? existingPrompt.favorite : false,
    cloud_id: existingPrompt ? existingPrompt.cloud_id : null,
    folder_id: document.getElementById('folder') ? (document.getElementById('folder').value || null) : null,
    // Implicit status & guest tracking
    user_id: user_session ? user_session.user.id : null,
    status: user_session ? 'syncing' : 'local-only',
    is_guest_data: !user_session
  };

  if (id) {
    const index = prompts.findIndex(p => String(p.id) === String(id));
    if (index > -1) {
      prompts[index] = { ...prompts[index], ...promptData };
    } else {
      prompts.unshift(promptData);
    }
  } else {
    prompts.unshift(promptData);
  }

  saveToLocalStorage();
  renderPrompts(searchInput?.value, currentFilter);
  closeModal();
  showToast('Prompt saved!');

  if (user_session) {
    syncService.enqueue({ type: 'create', local_id: promptData.id, payload: promptData });
  }
  if (window.tagManager) await window.tagManager.syncTagsToCloud();
}

function handleQuickAdd() {
  const quickPaste = document.getElementById('quickPaste');
  if (!quickPaste) return;
  let text = quickPaste.value.trim();
  if (!text) return;

  const analysis = analyzePrompt(text);
  const newPrompt = {
    id: crypto.randomUUID(),
    title: analysis.title,
    category: analysis.category,
    body: text,
    tags: analysis.tags,
    date: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    favorite: analysis.isLikelyFavorite,
    folder_id: activeFolderId,
    // Implicit status
    user_id: user_session ? user_session.user.id : null,
    status: user_session ? 'syncing' : 'local-only',
    is_guest_data: !user_session
  };

  prompts.unshift(newPrompt);
  saveToLocalStorage();
  renderPrompts(searchInput?.value, currentFilter);
  quickPaste.value = '';
  showToast('Saved!');

  if (user_session) {
    syncService.enqueue({ type: 'create', local_id: newPrompt.id, payload: newPrompt });
  }
  if (window.tagManager) window.tagManager.syncTagsToCloud(newPrompt.tags);
}

async function deletePrompt(id) {
  if (!confirm("Delete this prompt?")) return;

  const prompt = prompts.find(p => String(p.id) === String(id));
  if (!prompt) return;

  // 1. Remove Locally IMMEDIATELY
  prompts = prompts.filter(p => String(p.id) !== String(id));
  saveToLocalStorage();
  renderPrompts(searchInput?.value, currentFilter);
  showToast("Deleted");

  // 2. Handle Cloud Sync
  if (user_session) {
    syncService.enqueue({ type: 'delete', local_id: id });
  }
}

function queueOfflineDelete(cloudId) {
  if (!offlineDeletes.includes(cloudId)) {
    offlineDeletes.push(cloudId);
    localStorage.setItem('offlineDeletes', JSON.stringify(offlineDeletes));
  }
}

// Obsolete deletion sync removed. Replaced by syncService.

async function toggleFavorite(id) {
  const p = prompts.find(x => String(x.id) === String(id));
  if (!p) return;

  p.favorite = !p.favorite;
  p.updated_at = new Date().toISOString();
  saveToLocalStorage();
  renderPrompts(searchInput?.value, currentFilter);

  if (user_session) {
    syncService.enqueue({ type: 'update', local_id: p.id, payload: p });
  }
}

// ---------- Supabase Logic (Updated) ----------
// Obsolete savePromptToSupabase removed. Replaced by syncService.

async function loadPromptsFromSupabaseAndMerge() {
  if (!supabaseClient) return;

  try {
    let query = supabaseClient.from("prompt_saves").select("*").order("created_at", { ascending: false });

    // TASK 2: Show Only User’s Supabase Prompts
    if (user_session) {
      query = query.eq('user_id', user_session.user.id);
    } else {
      // If guest, show prompts for this device_id
      query = query.eq('device_id', device_id);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Load Error:", error);
      return;
    }

    if (!Array.isArray(data)) return;

    // Merge Logic: Last Write Wins (LWW)
    // 1. Map Cloud Data
    const cloudMap = new Map();
    data.forEach(row => {
      cloudMap.set(row.id, {
        id: row.id,
        cloud_id: row.id,
        title: row.title,
        body: row.body,
        tags: row.tags ? row.tags.split(',') : [],
        favorite: row.favorite,
        category: row.category,
        date: row.created_at,
        updated_at: row.updated_at || row.created_at, // Fallback if null
        device_id: row.device_id,
        user_id: row.user_id,
        folder_id: row.folder_id,
        storage: 'cloud'
      });
    });

    // 2. Iterate Local Prompts
    // - If synced (has cloud_id): Compare timestamps. 
    //   - Local > Cloud? Keep Local (and Queue for sync).
    //   - Cloud >= Local? Take Cloud.
    // - If unsynced (no cloud_id): Keep Local.

    const mergedPrompts = [];
    const localMap = new Map(); // Track what we've processed from local to avoid dupes

    prompts.forEach(localP => {
      localMap.set(localP.id, localP);

      if (localP.cloud_id && cloudMap.has(localP.cloud_id)) {
        const cloudP = cloudMap.get(localP.cloud_id);
        const localTime = new Date(localP.updated_at || 0).getTime(); // 0 if missing (legacy)
        const cloudTime = new Date(cloudP.updated_at).getTime();

        if (localTime > cloudTime) {
          // Local is newer. Keep Local and queue sync.
          console.log(`Conflict: Local (${localTime}) > Cloud (${cloudTime}). Keeping Local & Queuing.`);
          localP.status = 'syncing';
          localP.is_guest_data = false; // It's cloud-linked now
          mergedPrompts.push(localP);
          if (user_session) {
            syncService.enqueue({ type: 'update', local_id: localP.id, payload: localP });
          }
        } else {
          // Cloud is newer or equal. Accept Cloud.
          cloudP.status = 'synced';
          cloudP.is_guest_data = false;
          mergedPrompts.push(cloudP);
        }
        // Remove from cloudMap so we don't add it again as "new from cloud"
        cloudMap.delete(localP.cloud_id);
      } else {
        // Not in cloud (yet), or local-only. Keep it.
        mergedPrompts.push(localP);
      }
    });

    // 3. Add remaining Cloud items (New arrivals from other devices)
    for (const cloudP of cloudMap.values()) {
      mergedPrompts.push(cloudP);
    }

    prompts = mergedPrompts; // Replace
    prompts.sort((a, b) => new Date(b.date) - new Date(a.date));

    saveToLocalStorage();
    renderPrompts();

  } catch (err) {
    console.error("Merge Exception:", err);
  }
}

// ---------- Categories Logic ----------
function addNewCategory(catName) {
  if (!categories.includes(catName)) {
    categories.push(catName);
    localStorage.setItem('categories', JSON.stringify(categories));
    renderCategories();
    syncCategoriesToCloud();
  }
}

function renderCategories() {
  // 1. Filter Dropdown
  const filterHTML = `
        <div class="dropdown-option" data-value="all">All Categories</div>
        ${categories.map(c => `
            <div class="dropdown-option" data-value="${c}">${capitalize(c)}</div>
        `).join('')}
    `;
  customCategoryDropdown.querySelector('.dropdown-options').innerHTML = filterHTML;

  // 2. Modal Dropdown
  const modalHTML = `
        <div class="dropdown-option" data-value="other">Select Category</div>
        ${categories.filter(c => c !== 'other').map(c => `
            <div class="dropdown-option" data-value="${c}">${capitalize(c)}</div>
        `).join('')}
        <div class="dropdown-option" data-value="add_new" style="color:var(--primary-color); font-weight:bold;">+ Add New</div>
    `;
  modalCategoryDropdown.querySelector('.dropdown-options').innerHTML = modalHTML;

  // Re-bind events to new elements
  // (Actually the delegation in setupCustomDropdown handles clicks, but we just replaced content)
  // We don't need to re-bind click listeners to the container.
}

async function loadCategoriesFromCloud() {
  if (!supabaseClient || !device_id) return;
  const { data } = await supabaseClient.from('device_metadata').select('categories').eq('device_id', device_id).maybeSingle();
  if (data && data.categories && Array.isArray(data.categories)) {
    // Merge unique
    const set = new Set([...categories, ...data.categories]);
    categories = Array.from(set);
    localStorage.setItem('categories', JSON.stringify(categories));
    renderCategories();
  }
}

async function syncCategoriesToCloud() {
  if (!supabaseClient || !device_id) return;
  // If user is logged in, maybe store categories in profiles? 
  // For now stick to device_metadata to keep it simple, or link device_metadata to user?
  // Let's keep using device_metadata as a bucket for categories.

  await supabaseClient.from('device_metadata').upsert({
    device_id: device_id,
    categories: categories,
    updated_at: new Date().toISOString()
  }, { onConflict: 'device_id' });
}

// ---------- Folder System Logic ----------

async function syncFolders() {
  if (!supabaseClient) return;

  let query = supabaseClient.from('folders').select('*').order('created_at');

  if (user_session) {
    query = query.eq('user_id', user_session.user.id);
  } else {
    query = query.eq('device_id', device_id);
  }

  const { data, error } = await query;
  if (data && !error) {
    folders = data;
    localStorage.setItem('folders', JSON.stringify(folders));
    renderFolderStream();
  }
}

async function createFolder(name) {
  const newFolder = {
    id: crypto.randomUUID(),
    name: name,
    user_id: user_session ? user_session.user.id : null,
    created_at: new Date().toISOString()
  };

  folders.push(newFolder);
  localStorage.setItem('folders', JSON.stringify(folders));

  // Switch to it
  activeFolderId = newFolder.id;
  renderFolderStream();
  renderPrompts();

  if (supabaseClient) {
    await supabaseClient.from('folders').insert([{
      id: newFolder.id,
      user_id: user_session ? user_session.user.id : null,
      device_id: device_id,
      name: newFolder.name
    }]);
  }
}

async function deleteFolder(id) {
  if (!confirm("Delete this folder? Prompts inside will be moved to 'All Prompts'.")) return;

  // Eject prompts locally
  let changed = false;
  prompts.forEach(p => {
    if (p.folder_id === id) {
      p.folder_id = null;
      changed = true;
    }
  });

  if (changed) saveToLocalStorage();

  // Remove folder locally
  folders = folders.filter(f => f.id !== id);
  localStorage.setItem('folders', JSON.stringify(folders));

  if (activeFolderId === id) activeFolderId = null;

  renderFolderStream();
  renderPrompts();

  // Cloud Delete
  if (supabaseClient) {
    let query = supabaseClient.from('folders').delete().eq('id', id);
    if (user_session) {
      query = query.eq('user_id', user_session.user.id);
    } else {
      query = query.eq('device_id', device_id);
    }
    await query;
    // Note: SQL 'ON DELETE SET NULL' handles the prompts in cloud automatically!
  }
}

async function syncLocalFoldersToCloud() {
  if (!supabaseClient || folders.length === 0) return;

  const foldersToSync = folders.map(f => ({
    id: f.id,
    name: f.name,
    user_id: f.user_id || (user_session ? user_session.user.id : null),
    device_id: f.device_id || device_id,
    created_at: f.created_at || new Date().toISOString()
  }));

  const { error } = await supabaseClient
    .from('folders')
    .upsert(foldersToSync, { onConflict: 'id', ignoreDuplicates: false });

  if (error) console.error("Folder sync error", error);
}

// ---------- Folder UI Renderer ----------

function renderFolderStream() {
  console.log("renderFolderStream called", folders);
  const container = document.getElementById('folderStream');
  if (!container) return;

  container.innerHTML = '';

  // 1. All Prompts Pill
  const allPill = document.createElement('div');
  allPill.className = `folder-pill ${activeFolderId === null ? 'active' : ''}`;
  allPill.textContent = 'All Prompts';
  allPill.onclick = () => {
    activeFolderId = null;
    renderFolderStream();
    renderPrompts();
  };
  container.appendChild(allPill);

  // 2. Folder Pills
  folders.forEach(f => {
    const pill = document.createElement('div');
    pill.className = `folder-pill ${activeFolderId === f.id ? 'active' : ''}`;
    pill.innerHTML = `<span class="icon">📁</span> <span class="text">${escapeHtml(f.name)}</span>`;

    // Select
    pill.onclick = () => {
      activeFolderId = f.id;
      renderFolderStream();
      renderPrompts();
    };

    // Delete (Context Menu)
    pill.oncontextmenu = (e) => {
      e.preventDefault();
      deleteFolder(f.id);
    };

    container.appendChild(pill);
  });

  // 3. Add Button
  const addBtn = document.createElement('div');
  addBtn.className = 'folder-add-pill';
  addBtn.textContent = '+';
  addBtn.title = "New Folder";
  addBtn.onclick = () => {
    // Inline Input Replacement
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'folder-pill folder-rename-input';
    input.placeholder = 'Name';
    input.style.border = '1px solid var(--primary-color)';
    input.style.background = '#fff';

    container.replaceChild(input, addBtn);
    input.focus();

    const commit = () => {
      const name = input.value.trim();
      if (name) {
        createFolder(name);
      } else {
        renderFolderStream(); // Reset
      }
    };

    input.onblur = commit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { input.blur(); }
      if (e.key === 'Escape') { renderFolderStream(); }
    };
  };

  container.appendChild(addBtn);

  // 4. Update Dropdown in Modal (if open or generally)
  renderFolderDropdown();
}

function renderFolderDropdown() {
  const dropdown = document.getElementById('folderDropdown');
  if (!dropdown) return;

  const optionsContainer = dropdown.querySelector('.dropdown-options');

  let html = `<div class="dropdown-option" data-value="">No Folder</div>`;
  folders.forEach(f => {
    html += `<div class="dropdown-option" data-value="${f.id}">📁 ${escapeHtml(f.name)}</div>`;
  });

  optionsContainer.innerHTML = html;

  // Refresh selection UI if specific value set
  const currentVal = document.getElementById('folder').value;
  updateDropdownSelection(dropdown, currentVal);
}

function updateDropdownSelection(dropdown, value) {
  const selected = dropdown.querySelector('.dropdown-selected');
  const options = dropdown.querySelectorAll('.dropdown-option');
  let text = 'No Folder'; // Default text

  options.forEach(opt => {
    if (opt.dataset.value === value) {
      opt.classList.add('selected');
      text = opt.textContent;
    } else {
      opt.classList.remove('selected');
    }
  });

  selected.textContent = text;
}



// ---------- Helper Functions ----------
let resultsForResizeCheck = 0; // Global for resize listener

function renderPrompts(filterText = '', categoryFilter = 'all') {
  grid.innerHTML = '';

  // TASK 2: Pinned Welcome Prompt (Additive)
  // ONLY show in Guest Mode (!user_session) and when in 'All Prompts' without search
  if (!user_session && !filterText && categoryFilter === 'all' && !activeFolderId) {
    const pinnedCard = document.createElement('div');
    pinnedCard.className = 'prompt-card pinned-guide-card';
    pinnedCard.innerHTML = `
        <div class="card-header">
    <div class="card-title">👋 Welcome to Prompit</div>
    <div class="card-actions">
        <button class="icon-btn" onclick="dismissWelcomeCard(event)" title="Dismiss Welcome Guide">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        </button>
    </div>
</div>

<div class="category-badge">
    Getting Started
</div>

<div class="card-body">
This is your personal prompt library — built to help you think, create, and move faster. 🚀
    <br><br>
    • <strong>Save</strong> your best ChatGPT prompts in seconds.<br>
    • <strong>Organize</strong> them using tags & categories.<br>
    • <strong>Reuse</strong> and <strong>copy</strong> prompts with one click.<br>
    <br>
    Start by adding your first prompt above 👆
</div>

<div class="card-footer">
    <div class="tags">
        <span class="tag">#welcome</span>
        <span class="tag">#guide</span>
    </div>
</div>

      `;
    grid.appendChild(pinnedCard);
  }


  // --- Tier-1 Full-Text Search with Ranking & Highlighting ---
  const query = (filterText || '').trim().toLowerCase();
  let results = prompts
    .map(p => {
      // Prepare fields
      const title = p.title || '';
      const body = p.body || '';
      const tags = Array.isArray(p.tags) ? p.tags : (typeof p.tags === 'string' ? p.tags.split(',').map(t => t.trim()) : []);
      // Find matches
      let matchType = null, matchIdx = -1, matchLen = 0, snippet = '', matchField = '', matchValue = '';
      if (query && title.toLowerCase().includes(query)) {
        matchType = 'title';
        matchField = 'title';
        matchValue = title;
        matchIdx = title.toLowerCase().indexOf(query);
        matchLen = query.length;
      } else if (query && tags.some(tag => tag.toLowerCase().includes(query))) {
        matchType = 'tag';
        matchField = 'tags';
        matchValue = tags.find(tag => tag.toLowerCase().includes(query)) || '';
        matchIdx = matchValue.toLowerCase().indexOf(query);
        matchLen = query.length;
      } else if (query && body.toLowerCase().includes(query)) {
        matchType = 'body';
        matchField = 'body';
        matchValue = body;
        matchIdx = body.toLowerCase().indexOf(query);
        matchLen = query.length;
      }
      // Only include if matches query, category, AND folder
      const matchCat = categoryFilter === 'all' || p.category === categoryFilter;
      const matchFolder = !activeFolderId || p.folder_id === activeFolderId;

      if (matchFolder && ((query && matchType && matchCat) || (!query && matchCat))) {
        // Build snippet (for body, show context; for title/tag, show whole)
        if (matchType === 'body' && matchIdx !== -1) {
          const start = Math.max(0, matchIdx - 30);
          const end = Math.min(body.length, matchIdx + matchLen + 30);
          snippet = (start > 0 ? '…' : '') + body.substring(start, end) + (end < body.length ? '…' : '');
        } else if (matchType === 'title') {
          snippet = title;
        } else if (matchType === 'tag') {
          snippet = matchValue;
        } else {
          snippet = body.substring(0, 150) + (body.length > 150 ? '…' : '');
        }
        return { prompt: p, matchType, matchField, matchIdx, matchLen, snippet, matchValue };
      }
      return null;
    })
    .filter(Boolean);

  // Ranking: title > tag > body
  results.sort((a, b) => {
    // Priority 1: Favorite prompts come first
    if (a.prompt.favorite && !b.prompt.favorite) return -1;
    if (!a.prompt.favorite && b.prompt.favorite) return 1;

    // Priority 2: Search ranking (title > tag > body)
    const rank = { title: 0, tag: 1, body: 2 };
    if (rank[a.matchType] !== rank[b.matchType]) return rank[a.matchType] - rank[b.matchType];

    // Priority 3: Newer first
    return (new Date(b.prompt.date || 0)) - (new Date(a.prompt.date || 0));
  });

  // If no query, show all prompts (with favorites pinned at top)
  if (!query) {
    results = prompts
      .filter(p => (categoryFilter === 'all' || p.category === categoryFilter) && (!activeFolderId || p.folder_id === activeFolderId))
      .map(p => ({ prompt: p, matchType: null, snippet: p.body.substring(0, 150) + (p.body.length > 150 ? '…' : '') }))
      .sort((a, b) => {
        // Favorites always appear first, then by creation date
        if (a.prompt.favorite && !b.prompt.favorite) return -1;
        if (!a.prompt.favorite && b.prompt.favorite) return 1;
        return (new Date(b.prompt.date || 0)) - (new Date(a.prompt.date || 0));
      });
  }


  if (results.length === 0) {
    // Gentle empty state, only if no prompts at all
    if (!query && prompts.length === 0) {
      if (!user_session) {
        grid.innerHTML += `
          <div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 40px;">
            <p style="font-size: 1.2rem;">No prompts found.</p>
            <p>Create one to get started!</p>
          </div>
        `;
      }
    }
    // If searching, do NOT show aggressive "No results" message
    return;
  }

  // Sort results: Favorites first (by true/false), then by date
  results.sort((a, b) => {
    // Favorites always come first
    if (a.prompt.favorite && !b.prompt.favorite) return -1;
    if (!a.prompt.favorite && b.prompt.favorite) return 1;
    // Then sort by creation date (newer first)
    return (new Date(b.prompt.date || 0)) - (new Date(a.prompt.date || 0));
  });

  // Identify absolute newest prompt for the "New" badge
  const newestId = prompts.length > 0
    ? [...prompts].sort((a, b) => new Date(b.created_at || b.date) - new Date(a.created_at || a.date))[0].id
    : null;

  resultsForResizeCheck = results.length;

  // --- ROW LIMITATION LOGIC ---
  const container = document.getElementById('showMoreContainer');
  const btn = document.getElementById('loadMoreBtn');
  const btnText = btn?.querySelector('.btn-text');

  if (container && btn && btnText) {
    // Calculate items per row (columns)
    // Grid uses minmax(300px, 1fr) with 25px gap
    const gridWidth = grid.offsetWidth;
    const cardMinWidth = 300;
    const gap = 25;
    const columns = Math.floor((gridWidth + gap) / (cardMinWidth + gap)) || 1;
    const rowLimitCount = columns * 3;

    if (results.length > rowLimitCount && !isGridExpanded) {
      // Show button and slice results
      results = results.slice(0, rowLimitCount);
      container.classList.remove('hidden');
      btn.classList.remove('expanded');
      btnText.textContent = `Show More (${resultsForResizeCheck - rowLimitCount} more)`;
    } else if (isGridExpanded && resultsForResizeCheck > rowLimitCount) {
      // Still show button but with "Show Less" or different state
      container.classList.remove('hidden');
      btn.classList.add('expanded');
      btnText.textContent = "Show Less";
    } else {
      // No need for button
      container.classList.add('hidden');
    }
  }

  results.forEach((res, index) => {
    const p = res.prompt;
    const card = document.createElement('div');
    card.className = 'prompt-card';
    card.dataset.id = p.id;
    card.style.animationDelay = `${index * 0.05}s`;

    // Copy Button SVG
    const copyIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    // Fav Icon SVG
    const favIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
    // Delete Icon
    const trashIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
    // Edit Icon
    const editIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;

    // --- Highlighting ---
    function highlight(text, q) {
      if (!q || !text) return escapeHtml(text);
      // Escape regex special chars in q
      const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(safeQ, 'gi');
      return escapeHtml(text).replace(re, m => `<mark>${escapeHtml(m)}</mark>`);
    }

    // Highlight in snippet
    let snippetHtml = res.snippet;
    if (res.matchType && query) {
      snippetHtml = highlight(res.snippet, query);
    } else {
      snippetHtml = escapeHtml(res.snippet);
    }

    // Highlight in title/tags if match
    let titleHtml = escapeHtml(p.title);
    if (res.matchType === 'title' && query) titleHtml = highlight(p.title, query);

    const rawTags = Array.isArray(p.tags) ? p.tags : (typeof p.tags === 'string' ? p.tags.split(',').map(t => t.trim()) : []);
    const displayedTags = rawTags.slice(0, 5);
    const hiddenCount = rawTags.length - 5;

    let tagsHtml = displayedTags.map(t => {
      if (res.matchType === 'tag' && t.toLowerCase().includes(query)) return `<span class="tag"><mark>#${escapeHtml(t)}</mark></span>`;
      return `<span class="tag">#${escapeHtml(t)}</span>`;
    }).join('');

    if (hiddenCount > 0) {
      tagsHtml += `<span class="tag-more">+${hiddenCount}</span>`;
    }

    // Usage count (initialize to 0 if not set)
    const usageCount = typeof p.total_usage === 'number' ? p.total_usage : 0;
    const usageText = usageCount > 0 ? `Used ${usageCount} ${usageCount === 1 ? 'time' : 'times'}` : '';

    card.innerHTML = `
      <div class="card-header">
        <div class="card-title">
            ${titleHtml}
            ${p.id === newestId ? '<span class="badge-new">New</span>' : ''}
        </div>
        <div class="card-actions">
           <button class="icon-btn fav-btn ${p.favorite ? 'active' : ''}" onclick="toggleFavorite('${p.id}')" title="Favorite">${favIcon}</button>
           <button class="icon-btn" onclick="copyPrompt('${p.id}')" title="Copy">${copyIcon}</button>
           <button class="icon-btn" onclick="openEditModal('${p.id}')" title="Edit">${editIcon}</button>
           <button class="icon-btn" onclick="deletePrompt('${p.id}')" title="Delete" style="color:var(--danger-color);">${trashIcon}</button>
        </div>
      </div>
      <div class="category-badge" style="margin-bottom:8px;">${escapeHtml(p.category) || 'other'}</div>
      <div class="card-body">${snippetHtml}</div>
      <div class="card-footer">
          <div class="footer-left">
              <div class="tags">
                  ${tagsHtml}
              </div>
              <span class="age-text">${timeAgo(p.date)}</span>
          </div>
          <div class="footer-right">
              ${usageText ? `<div class="usage-text">${usageText}</div>` : ''}
              <button class="icon-btn share-btn-footer" onclick="sharePrompt('${p.id}')" title="Share (Public Link)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
              </button>
          </div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function autoGenerateTitle(text) {
  return text.split('\n')[0].substring(0, 20) + (text.length > 20 ? '...' : '');
}

function analyzePrompt(text) {
  const lowerText = text.toLowerCase();

  // Refined Heuristics
  const codeKeywords = ['function', 'const', 'var', 'import', 'class', 'def', 'return', 'fn ', 'pub ', 'using ', 'sql', 'select ', 'from ', 'where ', 'git ', 'npm ', 'docker', 'api', 'json', 'yaml'];
  const artKeywords = ['style', 'render', 'image', 'photo', '4k', 'realistic', 'midjourney', 'stable diffusion', 'dall-e', 'painting', 'sketch', 'unreal engine', 'cinema 4d', 'bokeh', 'portrait'];
  const writingKeywords = ['essay', 'blog', 'story', 'article', 'write', 'author', 'poem', 'fiction', 'chapter', 'outline', 'summary', 'paragraph', 'creative', 'journal'];

  const isCode = codeKeywords.some(kw => lowerText.includes(kw));
  const isArt = artKeywords.some(kw => lowerText.includes(kw));
  const isWriting = writingKeywords.some(kw => lowerText.includes(kw));

  let cat = 'other';
  if (isCode) cat = 'coding';
  else if (isArt) cat = 'art';
  else if (isWriting) cat = 'writing';
  // Fallback to writing if it's long enough and has no other triggers
  else if (text.split(' ').length > 15) cat = 'writing';

  // Smart Tag Detection
  const tags = [];
  if (isCode) tags.push('code');
  if (isArt) tags.push('ai-art');
  if (isWriting) tags.push('creative');
  if (lowerText.includes('prompt')) tags.push('engineer');

  return {
    title: autoGenerateTitle(text),
    tags: tags,
    category: cat,
    isLikelyFavorite: false
  };
}

function timeAgo(date) {
  if (!date) return 'Recently';
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  if (seconds < 10) return 'just now';
  const intervals = [
    { s: 31536000, l: 'year' },
    { s: 2592000, l: 'month' },
    { s: 86400, l: 'day' },
    { s: 3600, l: 'hour' },
    { s: 60, l: 'minute' }
  ];
  for (const i of intervals) {
    const count = Math.floor(seconds / i.s);
    if (count >= 1) return `${count} ${i.l}${count > 1 ? 's' : ''} ago`;
  }
  return seconds + 's ago';
}

function saveToLocalStorage() {
  localStorage.setItem('prompts', JSON.stringify(prompts));
  localStorage.setItem('folders', JSON.stringify(folders));
  localStorage.setItem('syncQueue', JSON.stringify(syncQueue));
  localStorage.setItem('categories', JSON.stringify(categories));
}

function applyTheme() {
  if (localStorage.getItem('theme') === 'dark') {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function dismissWelcomeCard(e) {
  if (e) {
    e.stopPropagation();
    const card = e.target.closest('.pinned-guide-card');
    if (card) card.style.display = 'none';
  }
  localStorage.setItem('welcomeCardDismissed', 'true');
  showToast('Welcome guide dismissed!');
}

// Track recent copies to prevent accidental double-counting within 2 seconds
const recentCopies = new Map();

function extractVariables(text) {
  const regex = /{{(.*?)}}/g;
  const matches = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    const varName = match[1].trim();
    if (varName) matches.add(varName);
  }
  return Array.from(matches);
}

let activeVariablePrompt = null;

function copyPrompt(id) {
  const p = prompts.find(x => String(x.id) === String(id));
  if (!p) return;

  const templatedBody = autoConvertVariables(p.body);

  // Direct copy of the templated version (without updating the library or UI)
  if (templatedBody !== p.body) {
    showToast('Converted and copied as template!');
    doCopy(templatedBody, id, true);
  } else {
    doCopy(templatedBody, id);
  }
}

function showVariableModal(prompt, vars) {
  activeVariablePrompt = prompt;
  variableFields.innerHTML = '';

  // Sort variables for a deterministic, professional feel
  vars.sort((a, b) => a.localeCompare(b)).forEach(v => {
    const field = document.createElement('div');
    field.className = 'variable-field';

    // Humanize label: "tone" -> "Tone"
    const humanLabel = v.charAt(0).toUpperCase() + v.slice(1);

    field.innerHTML = `
      <label>${escapeHtml(humanLabel)}</label>
      <input type="text" data-var="${escapeHtml(v)}" placeholder="What is the ${escapeHtml(v)}?">
    `;
    variableFields.appendChild(field);
  });

  variableModalOverlay.classList.remove('hidden');
  // Focus first input
  const firstInput = variableFields.querySelector('input');
  if (firstInput) setTimeout(() => firstInput.focus(), 100);
}

function handleVariableCopy() {
  if (!activeVariablePrompt) return;
  const inputs = variableFields.querySelectorAll('input, textarea');
  let finalPrompt = activeVariablePrompt.body;

  inputs.forEach(input => {
    const varName = input.dataset.var;
    const value = input.value || `{{${varName}}}`;
    // Replace all occurrences of this variable
    const re = new RegExp(`{{${varName}}}`, 'g');
    finalPrompt = finalPrompt.replace(re, value);
  });

  // Apply cleanup to the final merged result
  finalPrompt = cleanPromptText(finalPrompt);

  doCopy(finalPrompt, activeVariablePrompt.id);
  variableModalOverlay.classList.add('hidden');
  showToast('Template filled and copied to clipboard.');

  // Update usage count
  updateUsageCount(activeVariablePrompt.id);
}

copyFinalBtn.onclick = handleVariableCopy;

// ========== NEW TEMPLATE FLOW ==========
// (Using global lastPendingPrompt and selectedVariableWords from top of file)

// Heuristics to suggest likely variables
function suggestVariables(text) {
  const suggestions = new Set();
  const words = text.split(/\s+/);

  words.forEach((word, index) => {
    const cleanWord = word.replace(/[.,!?;:"'()[\]{}]/g, '');
    if (!cleanWord || cleanWord.length < 2) return;

    // Proper nouns (capitalized words not at start of sentence)
    if (index > 0 && /^[A-Z][a-z]+$/.test(cleanWord)) {
      suggestions.add(cleanWord);
    }

    // Quoted text patterns
    if (/^["'].*["']$/.test(word)) {
      suggestions.add(cleanWord);
    }

    // Placeholder patterns like [name], <topic>, etc.
    if (/^\[.*\]$/.test(word) || /^<.*>$/.test(word)) {
      suggestions.add(cleanWord.replace(/[\[\]<>]/g, ''));
    }

    // Numbers and dates
    if (/^\d+$/.test(cleanWord) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(cleanWord)) {
      suggestions.add(cleanWord);
    }
  });

  return suggestions;
}

// ========== NEW TEMPLATE FLOW ==========

function showVariableSelectionModal(prompt) {
  lastPendingPrompt = prompt;
  selectedVariableWords = new Set();
  const suggestions = suggestVariables(prompt.body);

  // Tokenize the prompt body into words and punctuation
  const tokens = prompt.body.split(/(\s+|[.,!?;:"'()[\]{}]|\n)/g).filter(t => t);

  varSelectPreview.innerHTML = '';
  tokens.forEach((token, index) => {
    if (/^\s+$/.test(token)) {
      // Whitespace - preserve it
      if (token.includes('\n')) {
        varSelectPreview.appendChild(document.createElement('br'));
      } else {
        varSelectPreview.appendChild(document.createTextNode(token));
      }
    } else if (/^[.,!?;:"'()[\]{}]+$/.test(token)) {
      // Punctuation
      const span = document.createElement('span');
      span.className = 'punctuation';
      span.textContent = token;
      varSelectPreview.appendChild(span);
    } else {
      // Word token
      const span = document.createElement('span');
      span.className = 'word-token';
      span.textContent = token;
      span.dataset.word = token;
      span.dataset.index = index;

      // Highlight and Auto-select suggested words
      if (suggestions.has(token)) {
        span.classList.add('suggested');
        span.classList.add('selected'); // Make it selected by default
        selectedVariableWords.add(token);
      }

      span.onclick = () => {
        span.classList.toggle('selected');
        if (span.classList.contains('selected')) {
          selectedVariableWords.add(token);
        } else {
          selectedVariableWords.delete(token);
        }
      };

      varSelectPreview.appendChild(span);
    }
  });

  varSelectOverlay.classList.remove('hidden');
}

function hideVariableSelectionModal() {
  varSelectOverlay.classList.add('hidden');
  lastPendingPrompt = null;
  selectedVariableWords = new Set();
}

function confirmVariableSelection() {
  console.log('Confirming selection...', {
    promptId: lastPendingPrompt ? lastPendingPrompt.id : 'null',
    selectedWords: Array.from(selectedVariableWords)
  });

  if (!lastPendingPrompt || selectedVariableWords.size === 0) {
    showToast('Select at least one word to use as a variable.');
    return;
  }

  // Replace selected words with {{var_name}} in the prompt body
  let newBody = lastPendingPrompt.body;

  selectedVariableWords.forEach(word => {
    // Create a variable name (lowercase, underscores for spaces)
    const varName = word.toLowerCase().replace(/\s+/g, '_');
    // Replace all occurrences of the word with the variable placeholder
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    newBody = newBody.replace(re, `{{${varName}}}`);
  });

  console.log('Transformed Body:', newBody);

  // Update the prompt
  const idx = prompts.findIndex(p => p.id === lastPendingPrompt.id);
  if (idx !== -1) {
    prompts[idx].body = newBody;
    saveToLocalStorage();

    // Sync to cloud if applicable
    if (user_session) {
      syncService.enqueue({ type: 'update', local_id: lastPendingPrompt.id, payload: prompts[idx] });
    }

    renderPrompts();
    showToast('Template created! Fill in the blanks now.');

    // Now show the fill modal
    hideVariableSelectionModal();
    const vars = extractVariables(newBody);
    if (vars.length > 0) {
      showVariableModal(prompts[idx], vars);
    }
  }
}

// Event Listeners for Template Flow


if (closeVarSelectModalBtn) {
  closeVarSelectModalBtn.onclick = hideVariableSelectionModal;
}

if (confirmVarSelectBtn) {
  console.log("Attaching confirmVarSelectBtn listener");
  confirmVarSelectBtn.onclick = confirmVariableSelection;
} else {
  console.error("confirmVarSelectBtn not found in DOM");
}

// Close modals on overlay click
if (templateChoiceOverlay) {
  templateChoiceOverlay.onclick = (e) => {
    if (e.target === templateChoiceOverlay) {
      hideTemplateChoiceModal();
    }
  };
}

if (varSelectOverlay) {
  varSelectOverlay.onclick = (e) => {
    if (e.target === varSelectOverlay) {
      hideVariableSelectionModal();
    }
  };
}

function doCopy(text, id, silent = false) {
  // 0. Smart Prompt Cleanup (Invisible Power)
  const cleanedText = cleanPromptText(text);

  const textArea = document.createElement("textarea");
  textArea.value = cleanedText;
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);

  if (!silent) showToast("Copied to clipboard!");
  if (id) updateUsageCount(id);

  // Visual feedback on button if possible
  const card = document.querySelector(`.prompt-card[data-id="${id}"]`);
  if (card) {
    const btn = card.querySelector('.icon-btn[title="Copy"]');
    if (btn) {
      btn.classList.add('copied-state');
      setTimeout(() => btn.classList.remove('copied-state'), 1500);
    }
  }
}

/**
 * Smart Prompt Cleanup: The "Invisible Janitor"
 * Collapses blank lines, trims edges, and normalizes breaks on usage.
 */
function cleanPromptText(text) {
  if (!text) return '';

  return text
    // 1. Normalize line endings & remove invisible junk
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00A0/g, ' ') // Normalize non-breaking spaces to regular spaces
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Strip zero-width junk
    // 2. Process line by line
    .split('\n')
    .map(line => {
      let l = line.trim();
      // Smart Bullet Spacing: "-Item" -> "- Item"
      return l.replace(/^([-*+•])(\S)/, '$1 $2');
    })
    .join('\n')
    // 3. Collapse multiple empty lines (max 1)
    .replace(/\n{3,}/g, '\n\n')
    // 4. Final edge trim
    .trim();
}

async function updateUsageCount(id) {
  const idx = prompts.findIndex(x => x.id === id);
  if (idx === -1) return;

  prompts[idx].total_usage = (prompts[idx].total_usage || 0) + 1;
  saveToLocalStorage();

  if (user_session && prompts[idx].cloud_id) {
    await supabaseClient.from('prompt_saves').update({
      total_usage: prompts[idx].total_usage
    }).eq('id', prompts[idx].cloud_id);
  }
}





function openModal() {
  document.getElementById('promptId').value = '';
  promptForm.reset();
  document.getElementById('modalTitle').textContent = 'Add Prompt';
  document.getElementById('category').value = 'other';
  updateCategoryDropdownUI(modalCategoryDropdown, 'other');

  // Reset manual interaction tracking
  hasManuallySetCategory = false;
  hasManuallySetTitle = false;

  // Reset Storage Selection (Default to Cloud for Modal)
  const radioCloud = document.querySelector('input[name="storageType"][value="cloud"]');
  if (radioCloud) radioCloud.checked = true;

  // Pre-select current folder if active
  const currentFolder = activeFolderId || '';
  document.getElementById('folder').value = currentFolder;
  renderFolderDropdown(); // Refresh options
  updateDropdownSelection(document.getElementById('folderDropdown'), currentFolder);

  modalOverlay.classList.remove('hidden');
  setTimeout(() => modalOverlay.classList.add('visible'), 10);
}

function openEditModal(id) {
  const p = prompts.find(x => String(x.id) === String(id));
  if (!p) return;
  document.getElementById('promptId').value = p.id;
  document.getElementById('title').value = p.title;
  document.getElementById('body').value = p.body;
  if (window.tagManager) window.tagManager.reset(p.tags);
  document.getElementById('category').value = p.category || 'other';
  updateCategoryDropdownUI(modalCategoryDropdown, p.category || 'other');

  // Load Storage Status
  const storage = (p.storage === 'local' || !p.cloud_id) ? 'local' : 'cloud';
  const radio = document.querySelector(`input[name="storageType"][value="${storage}"]`);
  if (radio) radio.checked = true;

  // Load Folder
  document.getElementById('folder').value = p.folder_id || '';
  renderFolderDropdown();
  updateDropdownSelection(document.getElementById('folderDropdown'), p.folder_id || '');

  document.getElementById('modalTitle').textContent = 'Edit Prompt';
  modalOverlay.classList.remove('hidden');
  setTimeout(() => modalOverlay.classList.add('visible'), 10);
}

function closeModal() {
  modalOverlay.classList.remove('visible');
  setTimeout(() => modalOverlay.classList.add('hidden'), 300);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  document.getElementById('toastMessage').textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('visible'), 10);
  setTimeout(() => {
    t.classList.remove('visible');
    setTimeout(() => t.classList.add('hidden'), 300);
  }, 2500);
}

// Global scope expose for onclick handlers
window.toggleFavorite = toggleFavorite;
window.deletePrompt = deletePrompt;
window.copyPrompt = copyPrompt;
window.openEditModal = openEditModal;

// Queue Offline
// Obsolete offline sync helpers removed. Replaced by SyncService.

function exportData() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(prompts));
  const downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute("href", dataStr);
  downloadAnchorNode.setAttribute("download", "prompit_backup.json");
  document.body.appendChild(downloadAnchorNode);
  downloadAnchorNode.click();
  downloadAnchorNode.remove();
}

function importDataFile(file) {
  if (!file) return;
  if (!confirm('Merge imported prompts?')) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!Array.isArray(imported)) throw new Error('Invalid JSON');

      const currentIds = new Set(prompts.map(p => p.id));
      let added = 0;
      for (const p of imported) {
        if (!currentIds.has(p.id)) {
          if (!p.category) p.category = 'other';
          // Initialize for new system
          p.user_id = user_session ? user_session.user.id : null;
          p.status = user_session ? 'syncing' : 'local-only';
          p.is_guest_data = !user_session;

          prompts.push(p);
          added++;

          if (user_session) {
            syncService.enqueue({ type: 'create', local_id: p.id, payload: p });
          }
        }
      }
      saveToLocalStorage();
      renderPrompts();
      showToast(`Imported ${added} prompts`);
    } catch (err) {
      alert('Import failed: invalid JSON');
      console.error(err);
    }
  };
  reader.readAsText(file);
}


// ========================================
// Smart Tags Manager
// ========================================
class TagManager {
  constructor() {
    this.tags = new Set();
    this.wrapper = document.getElementById('tagInputWrapper');
    this.container = document.getElementById('tagChips');
    this.input = document.getElementById('tagInput');
    this.hiddenInput = document.getElementById('tags');
    this.suggestionsBox = document.getElementById('tagSuggestions');
    this.savedTags = new Set(); // Global dictionary of tags

    this.init();
  }

  init() {
    if (!this.input) return;

    // Input events
    this.input.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.input.addEventListener('input', () => this.handleInput());
    this.input.addEventListener('focus', () => this.handleInput()); // Show suggestions on focus

    // Close suggestions on click outside
    document.addEventListener('click', (e) => {
      if (!this.wrapper.contains(e.target)) {
        this.closeSuggestions();
      }
    });

    this.loadGlobalTags();
  }

  // Load distinct tags for auto-suggestion
  async loadGlobalTags() {
    // 1. Load from local prompts
    prompts.forEach(p => {
      if (Array.isArray(p.tags)) p.tags.forEach(t => this.savedTags.add(t.toLowerCase()));
      else if (typeof p.tags === 'string') p.tags.split(',').forEach(t => this.savedTags.add(t.trim().toLowerCase()));
    });

    // 2. Load from DB (if connected)
    if (supabaseClient) {
      try {
        const { data, error } = await supabaseClient.from('tags').select('name').limit(100);
        if (error) {
          // Silent fail for missing table (42P01) or standard REST errors
          return;
        }
        if (data) data.forEach(row => this.savedTags.add(row.name.toLowerCase()));
      } catch (err) { /* silent fail */ }
    }
  }

  // Add a tag (from input or suggestion)
  addTag(tagName) {
    const cleanTag = tagName.trim().toLowerCase();
    if (!cleanTag) return;
    if (this.tags.has(cleanTag)) {
      this.input.value = ''; // Duplicate
      return;
    }

    this.tags.add(cleanTag);
    this.renderChips();
    this.input.value = '';
    this.closeSuggestions();
    this.updateHiddenInput();
  }

  // Remove a tag
  removeTag(tagName) {
    this.tags.delete(tagName);
    this.renderChips();
    this.updateHiddenInput();
  }

  // Render chips UI
  renderChips() {
    this.container.innerHTML = '';
    this.tags.forEach(tag => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip';
      chip.innerHTML = `
        ${escapeHtml(tag)}
        <span class="tag-chip-remove" onclick="tagManager.removeTag('${escapeHtml(tag)}')">&times;</span>
      `;
      this.container.appendChild(chip);
    });
  }

  // Update hidden CSV input for form submission
  updateHiddenInput() {
    this.hiddenInput.value = Array.from(this.tags).join(', ');
  }

  // Handle Input typing
  handleInput() {
    const query = this.input.value.trim().toLowerCase();
    if (query.length === 0) {
      // Optional: show recent/popular tags if empty? For now, nothing.
      // this.closeSuggestions();
      // return;
    }

    // Filter suggestions
    const matches = Array.from(this.savedTags)
      .filter(t => t.includes(query) && !this.tags.has(t))
      .slice(0, 5); // Limit to 5

    this.renderSuggestions(matches);
  }

  handleKeydown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      this.addTag(this.input.value);
    } else if (e.key === 'Backspace' && this.input.value === '' && this.tags.size > 0) {
      // Remove last tag on backspace
      const lastTag = Array.from(this.tags).pop();
      this.removeTag(lastTag);
    }
  }

  renderSuggestions(matches) {
    if (matches.length === 0) {
      this.closeSuggestions();
      return;
    }

    this.suggestionsBox.innerHTML = matches.map(tag => `
      <div class="tag-suggestion-item" onclick="tagManager.addTag('${tag}')">
        ${escapeHtml(tag)}
      </div>
    `).join('');

    this.suggestionsBox.classList.remove('hidden');
  }

  closeSuggestions() {
    this.suggestionsBox.classList.add('hidden');
    this.suggestionsBox.innerHTML = '';
  }

  // Reset for new/edit prompt
  reset(initialTags = []) {
    this.tags = new Set();
    if (Array.isArray(initialTags)) {
      initialTags.forEach(t => this.tags.add(t.trim().toLowerCase()));
    } else if (typeof initialTags === 'string') {
      initialTags.split(',').forEach(t => {
        const clean = t.trim().toLowerCase();
        if (clean) this.tags.add(clean);
      });
    }

    this.renderChips();
    this.updateHiddenInput();
    this.loadGlobalTags(); // Refresh suggestions
  }

  // Sync new tags to DB (called on Save)
  // Sync new tags to DB (called on Save)
  async syncTagsToCloud(tagsToSync = null) {
    if (!supabaseClient) return;
    const source = tagsToSync ? new Set(tagsToSync) : this.tags;
    const newTags = Array.from(source).map(name => ({ name }));

    // Fire and forget insert (ignore duplicates)
    if (newTags.length > 0) {
      try {
        await supabaseClient.from('tags').upsert(newTags, { onConflict: 'name', ignoreDuplicates: true });
      } catch (e) { console.warn('Tag sync error', e); }
    }
  }
}

// Init Tag Manager
const tagManager = new TagManager();
window.tagManager = tagManager; // global for onclicks


function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Onboarding Logic ----------
class OnboardingManager {
  constructor() {
    this.modal = document.getElementById('onboardingModal');
    this.slider = document.getElementById('onboardingSlides');
    this.dots = document.querySelectorAll('.dot');
    this.prevBtn = document.getElementById('prevSlide');
    this.nextBtn = document.getElementById('nextSlide');
    this.skipBtn = document.getElementById('skipOnboarding');
    this.finishBtn = document.getElementById('finishOnboarding');
    this.currentIndex = 0;
    this.totalSlides = 5;

    this.init();
  }

  init() {
    if (!this.modal) return;
    this.nextBtn.addEventListener('click', () => this.goToSlide(this.currentIndex + 1));
    this.prevBtn.addEventListener('click', () => this.goToSlide(this.currentIndex - 1));
    this.skipBtn.addEventListener('click', () => this.complete());
    this.finishBtn.addEventListener('click', () => this.complete());

    document.addEventListener('keydown', (e) => {
      if (!this.modal.classList.contains('hidden')) {
        if (e.key === 'ArrowRight') this.goToSlide(this.currentIndex + 1);
        if (e.key === 'ArrowLeft') this.goToSlide(this.currentIndex - 1);
        if (e.key === 'Escape') this.complete();
      }
    });

    // Dot navigation
    this.dots.forEach((dot, idx) => {
      dot.addEventListener('click', () => this.goToSlide(idx));
    });
  }

  goToSlide(index) {
    if (index < 0 || index >= this.totalSlides) return;
    this.currentIndex = index;
    this.updateUI();
  }

  updateUI() {
    // Slide transition
    this.slider.style.transform = `translateX(-${this.currentIndex * 100}%)`;

    // Active slide state for micro-animations
    const slides = document.querySelectorAll('.onboarding-slide');
    slides.forEach((s, idx) => {
      s.classList.toggle('active', idx === this.currentIndex);
    });

    // Update dots
    this.dots.forEach((dot, idx) => {
      dot.classList.toggle('active', idx === this.currentIndex);
    });

    // Update buttons
    this.prevBtn.disabled = this.currentIndex === 0;
    this.nextBtn.style.visibility = this.currentIndex === this.totalSlides - 1 ? 'hidden' : 'visible';
  }

  async show() {
    this.currentIndex = 0;
    this.updateUI();
    this.modal.classList.remove('hidden');
  }

  async complete() {
    this.modal.classList.add('hidden');
  }
}

const onboardingManager = new OnboardingManager();

function setupRealtime() {
  if (supabaseClient) {
    supabaseClient.channel('public:prompt_saves')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_saves' }, () => {
        loadPromptsFromSupabaseAndMerge();
      })
      .subscribe();
  }
}

// ADD THIS: Profile Renderer
function renderUserProfile(user) {
  const slot = document.getElementById('auth-profile-slot');
  if (!slot) return;

  if (!user) {
    slot.innerHTML = ''; // Clear if not logged in
    return;
  }

  const initial = user.email.charAt(0).toUpperCase();
  // Use CSS classes defined in style.css for consistent z-index and appearance
  slot.innerHTML = `
        <div class="profile-ui-container">
             <div class="profile-avatar" title="${user.email}">
                ${initial}
             </div>
             <div class="profile-dropdown-menu">
                <div class="profile-email">
                    ${user.email}
                </div>
                <button id="profileLogoutBtn" class="profile-logout-btn">
                     <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                    Logout
                </button>
             </div>
        </div>
    `;

  // Add simple toggle logic
  const container = slot.querySelector('.profile-ui-container');
  const avatar = slot.querySelector('.profile-avatar');
  const menu = slot.querySelector('.profile-dropdown-menu');

  avatar.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  document.addEventListener('click', () => {
    if (menu) menu.style.display = 'none';
  });

  document.getElementById('profileLogoutBtn').addEventListener('click', handleLogout);
}

// ADD THIS: Centralized Logout Handler
async function handleLogout() {
  // 1. Immediate UI Cleanup (Optimistic)
  user_session = null;
  renderUserProfile(null);
  updateAuthUI();
  showToast('Logged out');

  // Hide banner
  const banner = document.getElementById('welcome-banner');
  if (banner) banner.classList.add('hidden');

  // Revert prompts
  renderPrompts();

  // 2. Perform Supabase SignOut
  // Even if this fails or event doesn't fire, UI is already clean.
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    console.error('Logout error:', error);
  }
}

/* ADD THIS: Network Status Manager */
const NetworkManager = {
  overlay: document.getElementById('networkWarning'),
  stayGuestBtn: document.getElementById('netStayGuestBtn'),
  retryBtn: document.getElementById('netRetryBtn'),
  tryLoginBtn: document.getElementById('netTryLoginBtn'),

  init() {
    if (!this.overlay) return;

    // Listeners
    this.stayGuestBtn.addEventListener('click', () => this.stayGuest());
    this.retryBtn.addEventListener('click', () => this.checkConnection(true));
    this.tryLoginBtn.addEventListener('click', () => this.tryLogin());

    window.addEventListener('online', () => this.checkConnection(false));
    window.addEventListener('offline', () => this.show());

    // Initial Check
    if (!navigator.onLine ||
      (navigator.connection && ['slow-2g', '2g'].includes(navigator.connection.effectiveType))) {
      this.checkConnection(false);
    }
  },

  async checkConnection(manualRetry = false) {
    if (!manualRetry && localStorage.getItem('prompit_stay_guest') === '1') return;

    if (manualRetry) {
      const originalText = this.retryBtn.textContent;
      this.retryBtn.textContent = 'Checking...';
      this.retryBtn.disabled = true;
      this.retryBtn.style.opacity = '0.7';
      await new Promise(r => setTimeout(r, 600)); // Min UI delay for feel
    }

    const isReachable = await this.pingSupabase();

    if (manualRetry) {
      this.retryBtn.textContent = 'Retry Connection';
      this.retryBtn.disabled = false;
      this.retryBtn.style.opacity = '1';
    }

    if (isReachable) {
      this.hide();
      if (manualRetry) showToast('Connection Restored!');
    } else {
      this.show();
    }
  },

  async pingSupabase() {
    if (!navigator.onLine) return false;
    if (!supabaseClient) return true;

    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject('timeout'), 4000));
      await Promise.race([
        supabaseClient.from('prompt_saves').select('id').limit(1).maybeSingle(),
        timeout
      ]);
      return true;
    } catch (e) {
      return false;
    }
  },

  show() {
    if (localStorage.getItem('prompit_stay_guest') === '1') return;
    this.overlay.classList.remove('hidden');
  },

  hide() {
    this.overlay.classList.add('hidden');
  },

  stayGuest() {
    localStorage.setItem('prompit_stay_guest', '1');
    this.hide();
    showToast('Offline Mode Active');
  },

  tryLogin() {
    this.hide();
    showAuthOverlay();
  }
};

// ---------- Sharing System (Snapshot Logic) ----------

async function sharePrompt(id) {
  const prompt = prompts.find(p => String(p.id) === String(id));
  if (!prompt) return showToast('Prompt not found');

  if (!supabaseClient) {
    alert("Sharing requires a Cloud Connection. Please login or check your network.");
    return;
  }

  // 1. Generate Content Snapshot (Immutable)
  const snapshot = {
    title: prompt.title,
    body: cleanPromptText(prompt.body), // Clean before sharing
    tags: prompt.tags,
    category: prompt.category,
    created_at: new Date().toISOString()
  };

  // 2. Generate Hash (8 chars)
  const shortCode = crypto.randomUUID().split('-')[0]; // Simple 8-char hex

  // 3. Insert into shared_prompts
  try {
    const { error } = await supabaseClient
      .from('shared_prompts')
      .insert({
        short_code: shortCode,
        original_author_id: user_session ? user_session.user.id : null,
        content_snapshot: snapshot
      });

    if (error) throw error;

    // 4. Generate Link and Open Modal (YouTube Style)
    const shareUrl = `${window.location.origin}${window.location.pathname}?share=${shortCode}`;
    openShareModal(shareUrl, prompt.title);

  } catch (err) {
    console.error("Share Failed:", err);
    showToast('Failed to create share link.');
  }
}

function openShareModal(url, title) {
  const overlay = document.getElementById('shareModalOverlay');
  const input = document.getElementById('shareInputLink');
  const copyBtn = document.getElementById('shareCopyBtnMain');
  const closeBtn = document.getElementById('closeShareModal');

  // Set link
  input.value = url;

  // Reset Copy Logic
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = () => {
    input.select();
    navigator.clipboard.writeText(url);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => copyBtn.textContent = 'Copy', 2000);
  };

  // Setup Social Links
  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(`Check out this prompt: ${title}`);

  const wa = document.getElementById('shareWa');
  if (wa) wa.href = `https://wa.me/?text=${encodedTitle} ${encodedUrl}`;

  const x = document.getElementById('shareX');
  if (x) x.href = `https://twitter.com/intent/tweet?text=${encodedTitle}&url=${encodedUrl}`;

  const mail = document.getElementById('shareEmail');
  if (mail) mail.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodedTitle} ${encodedUrl}`;

  const li = document.getElementById('shareLinkedin');
  if (li) li.href = `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`;

  // Generic copy icon also copies
  const embed = document.getElementById('shareCopyIcon');
  if (embed) embed.onclick = () => {
    navigator.clipboard.writeText(url);
    showToast('Link copied to clipboard');
  };

  // Show
  overlay.classList.remove('hidden');

  // Close Logic
  const close = () => overlay.classList.add('hidden');
  closeBtn.onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  // Select text for easy copy
  setTimeout(() => input.select(), 100);
}

async function checkSharedLink() {
  const params = new URLSearchParams(window.location.search);
  const shareCode = params.get('share');

  if (shareCode) {
    console.log("Shared Link Detected:", shareCode);
    const success = await loadSharedPrompt(shareCode);
    return success;
  }
  return false;
}

async function loadSharedPrompt(code) {
  if (!supabaseClient) return false;

  // 1. Fetch Snapshot
  const { data, error } = await supabaseClient
    .from('shared_prompts')
    .select('*')
    .eq('short_code', code)
    .single();

  if (error || !data) {
    alert("This shared link is invalid or has been deleted.");
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
    return false;
  }

  // 2. Enter Viewer Mode
  enterViewerMode(data);
  return true;
}

function enterViewerMode(sharedParams) {
  const container = document.getElementById('sharedViewContainer');
  const contentArea = document.getElementById('sharedContentArea');
  const snapshot = sharedParams.content_snapshot;

  // Render Card
  contentArea.innerHTML = `
        <h1 class="shared-title">${escapeHtml(snapshot.title)}</h1>
        <div class="category-badge" style="margin-bottom:15px;">${escapeHtml(snapshot.category || 'other')}</div>
        <div class="shared-body">${escapeHtml(snapshot.body)}</div>
        <div class="tags" style="margin-top:20px;">
             ${(Array.isArray(snapshot.tags) ? snapshot.tags : []).map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}
        </div>
    `;

  // Bind Actions
  const copyBtn = document.getElementById('sharedCopyBtn');
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(snapshot.body);
    copyBtn.textContent = "Copied!";
    setTimeout(() => copyBtn.textContent = "Copy to Clipboard", 2000);
  };

  const saveBtn = document.getElementById('sharedSaveBtn');
  saveBtn.onclick = async () => {
    // Import logic
    const newPrompt = {
      id: crypto.randomUUID(),
      title: snapshot.title,
      body: snapshot.body,
      tags: snapshot.tags,
      category: snapshot.category,
      storage: user_session ? 'cloud' : 'local',
      date: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      favorite: false
    };

    prompts.unshift(newPrompt);
    saveToLocalStorage();
    renderPrompts();
    showToast('Saved to your Library! 💾');

    // Convert current view to standard app view
    container.classList.add('hidden');
    window.history.replaceState({}, document.title, window.location.pathname);

    if (user_session) {
      syncService.enqueue({ type: 'create', local_id: newPrompt.id, payload: newPrompt });
    }
  };

  // Show
  container.classList.remove('hidden');
}


// Debug
window.renderFolderStream = renderFolderStream;
window.createFolder = createFolder;

console.log("EOF reached - App.js Loaded. Triggering Boot...");

// Boot Sequence: Ensure DOM is ready, then trigger initApp
window.addEventListener('load', () => {
  console.log("Window Load Event - Starting App Boot...");
  initApp();
  NetworkManager.init();
});

// Re-expose for debug if needed
window.initApp = initApp;
window.prompts = prompts;
window.folders = folders;
window.supabaseClient = supabaseClient;
