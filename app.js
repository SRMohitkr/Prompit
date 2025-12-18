/*
=====================================================
⚠️ IMPORTANT: RUN THIS SQL IN SUPABASE SQL EDITOR FIRST!
=====================================================

-- 1. Create profiles table
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  last_login timestamp with time zone,
  created_at timestamp with time zone default now()
);
alter table public.profiles enable row level security;
create policy "Users can view own profile" on profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

-- 2. Create or Update prompt_saves table
create table if not exists public.prompt_saves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  device_id text,
  title text,
  body text,
  tags text,
  category text,
  favorite boolean default false,
  total_usage integer default 0,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone default now()
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
end $$;

-- Enforce types
alter table public.prompt_saves 
  alter column device_id type text,
  alter column body type text,
  alter column tags type text,
  alter column category type text;

-- 3. Create device_metadata table
create table if not exists public.device_metadata (
  device_id text primary key,
  categories text,
  updated_at timestamp with time zone default now()
);

-- 4. Enable RLS
alter table public.prompt_saves enable row level security;
alter table public.device_metadata enable row level security;

-- 5. RLS Policies (Drop old to avoid conflicts)
drop policy if exists "Enable all access for devices" on prompt_saves;
drop policy if exists "Users and Devices can manage their own prompts" on prompt_saves;
drop policy if exists "Devices can manage metadata" on device_metadata;

-- Policy 1 & 2 Combined: Guest (device_id) OR User (auth.uid)
create policy "Users and Devices can manage their own prompts" on prompt_saves
  for all using (
    (auth.uid() = user_id) OR 
    (device_id = current_setting('request.header.device-id', true))
  );

create policy "Devices can manage metadata" on device_metadata
  for all using (
    device_id = current_setting('request.header.device-id', true)
  );


-- 6. Folder System Support
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  name text not null,
  created_at timestamp with time zone default now()
);

-- RLS for Folders
alter table public.folders enable row level security;

create policy "Users can view own folders" on folders
  for select using (auth.uid() = user_id);

create policy "Users can create own folders" on folders
  for insert with check (auth.uid() = user_id);

create policy "Users can update own folders" on folders
  for update using (auth.uid() = user_id);

create policy "Users can delete own folders" on folders
  for delete using (auth.uid() = user_id);

-- Add folder_id to prompt_saves
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'prompt_saves' and column_name = 'folder_id') then
     alter table public.prompt_saves add column folder_id uuid references public.folders(id) on delete set null;
  end if;
end $$;

=====================================================
*/

// ---------- Init & Globals ----------
const SUPABASE_URL = window.SUPABASE_URL;
const SUPABASE_KEY = window.SUPABASE_ANON_KEY;
let supabase = null;
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

let offlineQueue = [];
try { offlineQueue = JSON.parse(localStorage.getItem('offlineQueue') || '[]'); } catch (e) { console.error('Corrupt Queue', e); localStorage.removeItem('offlineQueue'); }

let folders = [];
try { folders = JSON.parse(localStorage.getItem('folders') || '[]'); } catch (e) { console.error('Resetting Folders', e); localStorage.removeItem('folders'); }
let activeFolderId = null; // null = 'All Prompts'

console.log("App Start: Parsed Data", { prompts_len: prompts.length, offlineQueue_len: offlineQueue.length, folders_len: folders.length });


if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { 'device-id': device_id } }
  });
} else {
  console.warn("Supabase credentials missing in cloudConfig.js");
}

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
(async function initApp() {
  try {
    console.log("initApp running");
    applyTheme();
    setupEventListeners();
    setupAuthListeners();
    renderCategories();
    renderFolderStream();
    renderPrompts(); // Optimistic Render: Show cached data IMMEDIATELY before waiting for Auth/Supabase
    if (supabase) {
      supabase.auth.onAuthStateChange(async (event, session) => {
        // Handle both explicit SIGNED_IN and page load INITIAL_SESSION
        if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {

          // --- FIX: Trust the session ---
          // We do NOT sign out if intent is missing. 
          // We only check it to clean it up or for metrics if needed.
          const intent = localStorage.getItem('user_intent_login');
          if (intent) {
            console.log('Completing login flow...');
            localStorage.removeItem('user_intent_login'); // Cleanup
          } else {
            console.log('Session restored (Background/Guest to User).');
          }
          // -------------------------------

          user_session = session;
          hideAuthOverlay();
          renderUserProfile(session.user);
          updateAuthUI();

          // Show banner if session exists (and not dismissed previously if we had that logic)
          const banner = document.getElementById('welcome-banner');
          if (banner) banner.classList.remove('hidden');

          // Sync only if not just a refresh? 
          // Ideally syncData handles idempotency.
          if (event === 'SIGNED_IN') {
            await syncData();
          } else {
            // For INITIAL_SESSION, maybe we just load? 
            // syncData calls loadPromptsFromSupabaseAndMerge.
            // Let's call it to be safe and ensure data is fresh.
            await syncData();
          }

        } else if (event === 'SIGNED_OUT') {
          // Only run cleanup if not already done (avoid double toast)
          if (user_session) {
            user_session = null;
            renderUserProfile(null);
            updateAuthUI();
            renderPrompts();
            showToast('Logged out');
            const banner = document.getElementById('welcome-banner');
            if (banner) banner.classList.add('hidden');

            // Clear intent
            localStorage.removeItem('user_intent_login');
          }
        }
      });
    }

    // Auth Check - Removed manual getSession call as onAuthStateChange handles INITIAL_SESSION now.
    // We keep the else block for local-only non-supabase flow if configured without credentials?
    // But wait, if we rely on INITIAL_SESSION, we might need to wait for it?
    // Actually, onAuthStateChange fires 'INITIAL_SESSION' very quickly on load.
    // However, for pure Guest Mode (no session ever), we might need to handle the case where no event fires?
    // Supabase Auth listener usually handles the session check internally.
    // BUT the previous code had a specific check:
    // if (!user_session) showAuthOverlay();

    // Let's rely on the listener. If no session comes in, we might stay in "guest" implicitly?
    // But we need to show the Auth Overlay if appropriate.

    // To match previous behavior safely:
    if (supabase) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        showAuthOverlay();
      }
      // ALWAYS render cached prompts initially to prevent empty state
      renderPrompts();
      // If session exists, onAuthStateChange will handle it (INITIAL_SESSION)
    } else {
      // No Supabase, just render local
      renderPrompts();
    }

    // Force render folders (safe)
    try { renderFolderStream(); } catch (e) { console.error("Render Stream Failed", e); } // id: added-try-catch

  } catch (err) {
    console.error("Init App Error:", err);
    // Fallback
    renderPrompts();
  }
})();

// Debug
// (Moved debug assignments to EOF)

async function syncData() {
  await loadCategoriesFromCloud();
  await syncFolders(); // Folder Sync
  await syncOfflineQueue();
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
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: window.location.origin // Ensure OTP code is sent
      }
    });
    setLoading(sendOtpBtn, false);

    if (error) {
      alert('Error sending login code: ' + error.message);
    } else {
      authEmailForm.classList.add('hidden');
      // DO NOT SHOW OTP FORM. Hide it and show message instead.
      // authOtpForm.classList.remove('hidden'); 
      document.getElementById('sentEmailAddress').textContent = email;
      document.getElementById('authCheckEmail').classList.remove('hidden');
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
    const { data: { session }, error } = await supabase.auth.verifyOtp({
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
      await supabase.from('profiles').upsert({
        id: session.user.id,
        email: session.user.email,
        last_login: new Date().toISOString()
      });

      hideAuthOverlay();
      showToast(`Welcome, ${session.user.email.split('@')[0]}!`);
      updateAuthUI();

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
  if (!supabase || !device_id) return;

  // 1. Fetch prompts linked to device_id that have NO user_id
  const { data: devicePrompts, error } = await supabase
    .from('prompt_saves')
    .select('id')
    .eq('device_id', device_id)
    .is('user_id', null);

  if (error || !devicePrompts || devicePrompts.length === 0) return;

  const idsToMigrate = devicePrompts.map(p => p.id);

  // 2. Update them to set user_id
  const { error: updateError } = await supabase
    .from('prompt_saves')
    .update({ user_id: userId })
    .in('id', idsToMigrate);

  if (updateError) {
    console.warn('Migration failed', updateError);
  } else {
    console.log(`Migrated ${idsToMigrate.length} prompts to user.`);
    showToast(`Synced ${idsToMigrate.length} prompts to account!`);
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
    document.getElementById('title').value = analysis.title;
    // Set category using custom event to update dropdown UI
    updateCategoryDropdownUI(modalCategoryDropdown, analysis.category);
    if (window.tagManager) window.tagManager.reset(analysis.tags);
  });

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

    // Visual Active State
    const selectedEl = customCategoryDropdown.querySelector('.dropdown-selected');
    if (val !== 'all') {
      selectedEl.classList.add('active-filter');
    } else {
      selectedEl.classList.remove('active-filter');
    }
  });

  setupCustomDropdown(modalCategoryDropdown, (val) => {
    document.getElementById('category').value = val;
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

// ---------- CRUD Logic ----------

async function handleFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('promptId').value;
  const title = document.getElementById('title').value;
  const category = document.getElementById('category').value || 'other';
  const body = document.getElementById('body').value;
  const tags = document.getElementById('tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const storageType = document.querySelector('input[name="storageType"]:checked')?.value || 'cloud';

  const promptData = {
    id: id || crypto.randomUUID(), // Use UUID for local ID too
    title: title || autoGenerateTitle(body),
    category,
    body,
    tags,
    date: new Date().toISOString(),
    favorite: id ? (prompts.find(p => p.id === id)?.favorite || false) : false,
    cloud_id: id ? (prompts.find(p => p.id === id)?.cloud_id) : undefined,
    folder_id: document.getElementById('folder') ? (document.getElementById('folder').value || null) : null,
    storage: storageType
  };

  if (id) {
    const index = prompts.findIndex(p => p.id === id);
    if (index > -1) prompts[index] = { ...prompts[index], ...promptData };
  } else {
    prompts.unshift(promptData);
  }

  saveToLocalStorage();
  renderPrompts();
  closeModal();
  showToast('Prompt saved!');

  if (storageType === 'cloud') {
    await savePromptToSupabase(promptData);
  }
  if (window.tagManager) await window.tagManager.syncTagsToCloud();
}

function handleQuickAdd() {
  const quickPaste = document.getElementById('quickPaste');
  if (!quickPaste) return;
  const text = quickPaste.value.trim();
  if (!text) return;

  const analysis = analyzePrompt(text);
  const newPrompt = {
    id: crypto.randomUUID(),
    title: analysis.title,
    category: analysis.category,
    body: text,
    tags: analysis.tags,
    date: new Date().toISOString(),
    favorite: analysis.isLikelyFavorite,
    storage: 'local' // keep local default for quick save
  };

  prompts.unshift(newPrompt);
  saveToLocalStorage();
  renderPrompts();
  quickPaste.value = '';
  showToast('Saved locally!');
  // skip savePromptToSupabase(newPrompt) for local default
  if (window.tagManager) window.tagManager.syncTagsToCloud(newPrompt.tags);
}

async function deletePrompt(id) {
  if (!confirm("Delete this prompt?")) return;

  const prompt = prompts.find(p => p.id === id);
  if (!prompt) return;

  prompts = prompts.filter(p => p.id !== id);
  saveToLocalStorage();
  renderPrompts();
  showToast("Deleted");

  if (prompt.cloud_id && supabase) {
    let query = supabase.from("prompt_saves").delete().eq("id", prompt.cloud_id);

    // RLS: Add correct filter
    if (user_session) {
      query = query.eq('user_id', user_session.user.id);
    } else {
      query = query.eq('device_id', device_id);
    }

    const { error } = await query;
    if (error) console.error("Cloud delete failed:", error);
  }
}

async function toggleFavorite(id) {
  const p = prompts.find(x => x.id === id);
  if (!p) return;

  p.favorite = !p.favorite;
  saveToLocalStorage();
  renderPrompts(); // Optimistic

  if (p.cloud_id && supabase) {
    let query = supabase.from('prompt_saves').update({ favorite: p.favorite }).eq('id', p.cloud_id);

    // RLS: Add correct filter
    if (user_session) {
      query = query.eq('user_id', user_session.user.id);
    } else {
      query = query.eq('device_id', device_id);
    }

    const { error } = await query;
    if (error) {
      console.error("Cloud fav update failed:", error);
      queueOffline(p);
    }
  } else {
    savePromptToSupabase(p);
  }
}

// ---------- Supabase Logic (Updated) ----------
async function savePromptToSupabase(prompt) {
  // If explicitly local and not already on cloud, skip
  if (prompt.storage === 'local' && !prompt.cloud_id) {
    return null;
  }

  if (!supabase) {
    queueOffline(prompt);
    return null;
  }

  const categoryVal = prompt.category || 'other';
  const tagsStr = Array.isArray(prompt.tags) ? prompt.tags.join(",") : (prompt.tags || "");

  const payload = {
    title: prompt.title,
    body: prompt.body,
    tags: tagsStr,
    favorite: !!prompt.favorite,
    category: categoryVal,
    folder_id: prompt.folder_id || null, // Folder support
    user_id: user_session ? user_session.user.id : null,
    device_id: device_id
  };

  try {
    if (prompt.cloud_id) {
      // UPDATE
      let query = supabase.from("prompt_saves").update(payload).eq('id', prompt.cloud_id);

      // RLS Safety Check
      if (user_session) {
        query = query.eq('user_id', user_session.user.id);
      } else {
        query = query.eq('device_id', device_id);
      }

      const { data, error } = await query.select().single();

      if (error) throw error;
      return data;
    } else {
      // INSERT
      const { data, error } = await supabase
        .from("prompt_saves")
        .insert([payload])
        .select()
        .single();

      if (error) throw error;

      // Update local
      const localIdx = prompts.findIndex(p => p.id === prompt.id);
      if (localIdx > -1) {
        prompts[localIdx].cloud_id = data.id;
        prompts[localIdx].storage = 'cloud'; // Mark as cloud since it's now synced
        saveToLocalStorage();
      }
      return data;
    }
  } catch (err) {
    console.error("savePromptToSupabase error:", err);
    queueOffline(prompt);
    return null;
  }
}

async function loadPromptsFromSupabaseAndMerge() {
  if (!supabase) return;

  try {
    let query = supabase.from("prompt_saves").select("*").order("created_at", { ascending: false });

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

    // Merge Logic
    // 1. Cloud data is source of truth for synced items.
    // 2. Local items without cloud_id are preserved.

    const cloudMap = new Map();
    data.forEach(row => {
      cloudMap.set(row.id, {
        id: row.id, // Use cloud UUID
        cloud_id: row.id,
        title: row.title,
        body: row.body,
        tags: row.tags ? row.tags.split(',') : [],
        favorite: row.favorite,
        category: row.category,
        date: row.created_at,
        date: row.created_at,
        device_id: row.device_id,
        user_id: row.user_id,
        folder_id: row.folder_id // Map folder_id
      });
    });

    // Rebuild prompts array
    const mergedPrompts = [];

    // Add all cloud items
    for (const item of cloudMap.values()) {
      mergedPrompts.push(item);
    }

    // Add local items that are NOT in cloud yet
    // Strategy: if local item has a cloud_id, ignore it (cloud version wins).
    // If local item has NO cloud_id, keep it.
    for (const localItem of prompts) {
      if (!localItem.cloud_id) {
        mergedPrompts.push(localItem);
      }
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
        ${categories.map(c => `
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
  if (!supabase || !device_id) return;
  const { data } = await supabase.from('device_metadata').select('categories').eq('device_id', device_id).single();
  if (data && data.categories && Array.isArray(data.categories)) {
    // Merge unique
    const set = new Set([...categories, ...data.categories]);
    categories = Array.from(set);
    localStorage.setItem('categories', JSON.stringify(categories));
    renderCategories();
  }
}

async function syncCategoriesToCloud() {
  if (!supabase || !device_id) return;
  // If user is logged in, maybe store categories in profiles? 
  // For now stick to device_metadata to keep it simple, or link device_metadata to user?
  // Let's keep using device_metadata as a bucket for categories.

  await supabase.from('device_metadata').upsert({
    device_id: device_id,
    categories: categories,
    updated_at: new Date().toISOString()
  }, { onConflict: 'device_id' });
}

// ---------- Folder System Logic ----------

async function syncFolders() {
  if (!supabase || !user_session) return; // Only sync if logged in

  const { data, error } = await supabase.from('folders').select('*').order('created_at');
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

  if (user_session && supabase) {
    await supabase.from('folders').insert([{
      id: newFolder.id,
      user_id: user_session.user.id,
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
  if (user_session && supabase) {
    await supabase.from('folders').delete().eq('id', id);
    // Note: SQL 'ON DELETE SET NULL' handles the prompts in cloud automatically!
  }
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
function renderPrompts(filterText = '', categoryFilter = 'all') {
  grid.innerHTML = '';

  // TASK 2: Pinned Welcome Prompt (Additive)
  // Show for EVERYONE (Guests + Logged In) if not searching AND in 'All Prompts'
  if (!filterText && categoryFilter === 'all' && !activeFolderId) {
    const pinnedCard = document.createElement('div');
    pinnedCard.className = 'prompt-card pinned-guide-card';
    pinnedCard.innerHTML = `
        <div class="card-header">
    <div class="card-title">👋 Welcome to Prompit</div>
    <div class="card-actions">
        <button class="icon-btn" title="Pinned">📌</button>
    </div>
</div>

<div class="category-badge" style="background:rgba(255,255,255,0.2);">
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
    return (b.prompt.created_at || 0) > (a.prompt.created_at || 0) ? 1 : -1;
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
        return (b.prompt.created_at || 0) > (a.prompt.created_at || 0) ? 1 : -1;
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
    return (b.prompt.created_at || 0) > (a.prompt.created_at || 0) ? 1 : -1;
  });

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

    let tagsHtml = (Array.isArray(p.tags) ? p.tags : (typeof p.tags === 'string' ? p.tags.split(',').map(t => t.trim()) : [])).map(t => {
      if (res.matchType === 'tag' && t.toLowerCase().includes(query)) return `<span class="tag"><mark>#${escapeHtml(t)}</mark></span>`;
      return `<span class="tag">#${escapeHtml(t)}</span>`;
    }).join('');

    // Usage count (initialize to 0 if not set)
    const usageCount = typeof p.total_usage === 'number' ? p.total_usage : 0;
    const usageText = usageCount > 0 ? `Used ${usageCount} ${usageCount === 1 ? 'time' : 'times'}` : '';

    card.innerHTML = `
      <div class="card-header">
        <div class="card-title">
            ${titleHtml}
            ${(new Date() - new Date(p.date || 0)) < 86400000 ? '<span class="badge-new">New</span>' : ''}
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
         <div class="tags">
            ${tagsHtml}
         </div>
         ${usageText ? `<div class="usage-text">${usageText}</div>` : ''}
      </div>
    `;
    grid.appendChild(card);
  });
}

function autoGenerateTitle(text) {
  return text.split('\n')[0].substring(0, 20) + (text.length > 20 ? '...' : '');
}

function analyzePrompt(text) {
  // Simple heuristic
  const isCode = /function|const|var|import|class|def|return/.test(text);
  const isArt = /style|render|image|photo|4k|realistic/.test(text);
  const isWriting = !isCode && !isArt;

  let cat = 'other';
  if (isCode) cat = 'coding';
  if (isArt) cat = 'art';
  if (isWriting) cat = 'writing';

  return {
    title: autoGenerateTitle(text),
    tags: [],
    category: cat,
    isLikelyFavorite: false
  };
}

function saveToLocalStorage() {
  localStorage.setItem('prompts', JSON.stringify(prompts));
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

// Track recent copies to prevent accidental double-counting within 2 seconds
const recentCopies = new Map();

function extractVariables(text) {
  const regex = /{{(.*?)}}/g;
  const matches = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[1].trim()) matches.add(match[1].trim());
  }
  return Array.from(matches);
}

let activeVariablePrompt = null;

function copyPrompt(id) {
  const p = prompts.find(x => x.id === id);
  if (!p) return;

  const vars = extractVariables(p.body);
  if (vars.length > 0) {
    showVariableModal(p, vars);
    return;
  }

  // Normal copy
  doCopy(p.body, id);
}

function showVariableModal(prompt, vars) {
  activeVariablePrompt = prompt;
  variableFields.innerHTML = '';

  vars.forEach(v => {
    const field = document.createElement('div');
    field.className = 'variable-field';
    field.innerHTML = `
      <label>${escapeHtml(v)}</label>
      <input type="text" data-var="${escapeHtml(v)}" placeholder="Type something for ${escapeHtml(v)}...">
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

  let finalBody = activeVariablePrompt.body;
  const inputs = variableFields.querySelectorAll('input');

  inputs.forEach(input => {
    const varName = input.getAttribute('data-var');
    const value = input.value.trim() || `{{${varName}}}`; // Keep it if empty or a default?
    // Replace all occurrences of {{varName}}
    const re = new RegExp(`{{${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}}}`, 'gi');
    finalBody = finalBody.replace(re, value);
  });

  navigator.clipboard.writeText(finalBody);
  variableModalOverlay.classList.add('hidden');
  showToast('Prompt copied with variables!');

  // Update usage count
  updateUsageCount(activeVariablePrompt.id);
}

copyFinalBtn.onclick = handleVariableCopy;

function doCopy(text, id) {
  navigator.clipboard.writeText(text);
  showToast('Copied to clipboard!');

  // Visual feedback
  const card = document.querySelector(`[data-id="${id}"]`);
  if (card) {
    const copyBtn = card.querySelector('.card-actions button:nth-child(2)');
    if (copyBtn) {
      const checkIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      const originalHTML = copyBtn.innerHTML;
      copyBtn.innerHTML = checkIcon;
      copyBtn.classList.add('copied-state');
      setTimeout(() => {
        copyBtn.innerHTML = originalHTML;
        copyBtn.classList.remove('copied-state');
      }, 1500);
    }
  }

  updateUsageCount(id);
}

async function updateUsageCount(id) {
  const idx = prompts.findIndex(x => x.id === id);
  if (idx === -1) return;

  prompts[idx].total_usage = (prompts[idx].total_usage || 0) + 1;
  saveToLocalStorage();

  if (user_session && prompts[idx].cloud_id) {
    await supabase.from('prompt_saves').update({
      total_usage: prompts[idx].total_usage
    }).eq('id', prompts[idx].cloud_id);
  }
}

function copyPrompt_OLD(id) {
  // Safeguard: Prevent incrementing usage twice within 2 seconds
  const now = Date.now();
  const lastCopyTime = recentCopies.get(id) || 0;
  if (now - lastCopyTime < 2000) {
    return; // Already counted recently, skip increment
  }

  // Mark this copy time
  recentCopies.set(id, now);

  // Initialize usage fields if they don't exist
  if (typeof p.total_usage !== 'number') {
    p.total_usage = 0;
  }

  // Increment usage count
  p.total_usage += 1;
  p.last_used_at = new Date().toISOString();

  // Save locally
  saveToLocalStorage();
  renderPrompts(); // Re-render to show updated usage count

  // Sync to cloud if user is logged in or has cloud_id
  if (p.cloud_id && supabase) {
    syncUsageToCloud(p);
  } else {
    savePromptToSupabase(p);
  }
}

async function syncUsageToCloud(prompt) {
  if (!supabase) return;

  try {
    let query = supabase
      .from('prompt_saves')
      .update({
        total_usage: prompt.total_usage,
        last_used_at: prompt.last_used_at
      })
      .eq('id', prompt.cloud_id);

    // RLS: Add correct filter
    if (user_session) {
      query = query.eq('user_id', user_session.user.id);
    } else {
      query = query.eq('device_id', device_id);
    }

    const { error } = await query;
    if (error) {
      console.error("Cloud usage update failed:", error);
      queueOffline(prompt);
    }
  } catch (err) {
    console.error('Usage sync exception:', err);
    queueOffline(prompt);
  }
}

function openModal() {
  document.getElementById('promptId').value = '';
  promptForm.reset();
  document.getElementById('modalTitle').textContent = 'Add Prompt';
  document.getElementById('category').value = 'other';
  updateCategoryDropdownUI(modalCategoryDropdown, 'other');

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
  const p = prompts.find(x => x.id === id);
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
function queueOffline(item) {
  offlineQueue.push({
    ...item,
    localId: item.id
  });
  localStorage.setItem('offlineQueue', JSON.stringify(offlineQueue));
  showToast('Offline: Queued for sync');
}

async function syncOfflineQueue() {
  offlineQueue = JSON.parse(localStorage.getItem('offlineQueue') || '[]');
  if (!supabase || !offlineQueue.length) return;

  const queue = [...offlineQueue];
  const remaining = [];

  for (const item of queue) {
    try {
      // Try Insert
      // IF user logged in, attach user_id, else just device_id
      const payload = {
        device_id: device_id,
        user_id: user_session ? user_session.user.id : null,
        title: item.title,
        body: item.body,
        tags: item.tags,
        favorite: item.favorite,
        category: item.category || 'other'
      };

      const { data, error } = await supabase
        .from("prompt_saves")
        .insert([payload])
        .select()
        .single();

      if (error) {
        console.error('Sync item failed:', error);
        remaining.push(item);
      } else {
        const idx = prompts.findIndex(p => p.id === item.localId);
        if (idx > -1) prompts[idx].cloud_id = data.id;
      }
    } catch (err) {
      console.error('Sync exception:', err);
      remaining.push(item);
    }
  }

  offlineQueue = remaining;
  localStorage.setItem('offlineQueue', JSON.stringify(offlineQueue));
  saveToLocalStorage();
  if (queue.length > remaining.length) showToast('Offline prompts synced!');
}

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
          prompts.push(p);
          added++;
          savePromptToSupabase(p);
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
    if (supabase) {
      try {
        const { data } = await supabase.from('tags').select('name').limit(100);
        if (data) data.forEach(Row => this.savedTags.add(Row.name.toLowerCase()));
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
    if (!supabase) return;
    const source = tagsToSync ? new Set(tagsToSync) : this.tags;
    const newTags = Array.from(source).map(name => ({ name }));

    // Fire and forget insert (ignore duplicates)
    if (newTags.length > 0) {
      try {
        await supabase.from('tags').upsert(newTags, { onConflict: 'name', ignoreDuplicates: true });
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

function setupRealtime() {
  if (supabase) {
    supabase.channel('public:prompt_saves')
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
  const { error } = await supabase.auth.signOut();
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
    if (!supabase) return true;

    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject('timeout'), 4000));
      await Promise.race([
        supabase.from('prompt_saves').select('id').limit(1).maybeSingle(),
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
// Debug
window.renderFolderStream = renderFolderStream;
window.createFolder = createFolder;
console.log("EOF reached - App.js Loaded");
document.addEventListener('DOMContentLoaded', () => NetworkManager.init());
