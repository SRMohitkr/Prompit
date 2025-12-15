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
  created_at timestamp with time zone default now()
);

-- Ensure columns are TEXT and exist (Idempotent Migration)
do $$
begin
  -- Rename prompt_text to body if it exists and body prevents clean setup
  if exists (select 1 from information_schema.columns where table_name = 'prompt_saves' and column_name = 'prompt_text') then
     alter table public.prompt_saves rename column prompt_text to body;
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
let categories = JSON.parse(localStorage.getItem('categories') || JSON.stringify(DEFAULT_CATEGORIES));

// Prompts Data
let prompts = JSON.parse(localStorage.getItem('prompts') || '[]');
let offlineQueue = JSON.parse(localStorage.getItem('offlineQueue') || '[]');

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
  applyTheme();
  setupEventListeners();
  setupAuthListeners();
  renderCategories();
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
})();

async function syncData() {
  await loadCategoriesFromCloud();
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
    document.getElementById('tags').value = analysis.tags.join(', ');
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

  // Quick Paste Enter Key
  document.getElementById('quickPaste').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleQuickAdd();
  });
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

  const promptData = {
    id: id || crypto.randomUUID(), // Use UUID for local ID too
    title: title || autoGenerateTitle(body),
    category,
    body,
    tags,
    date: new Date().toISOString(),
    favorite: id ? (prompts.find(p => p.id === id)?.favorite || false) : false,
    cloud_id: id ? (prompts.find(p => p.id === id)?.cloud_id) : undefined
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

  await savePromptToSupabase(promptData);
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
    favorite: analysis.isLikelyFavorite
  };

  prompts.unshift(newPrompt);
  saveToLocalStorage();
  renderPrompts();
  quickPaste.value = '';
  showToast('Saved!');
  savePromptToSupabase(newPrompt);
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
    // If logged in, attach user_id. Always attach device_id for tracking history if needed.
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
        device_id: row.device_id, // keep metadata
        user_id: row.user_id
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


// ---------- Helper Functions ----------
function renderPrompts(filterText = '', categoryFilter = 'all') {
  grid.innerHTML = '';

  // TASK 2: Pinned Welcome Prompt (Additive)
  // Show for EVERYONE (Guests + Logged In) if not searching
  if (!filterText && categoryFilter === 'all') {
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

  const filtered = prompts.filter(p => {
    const matchText = (p.title + p.body + (p.tags || []).join(' ')).toLowerCase().includes(filterText.toLowerCase());
    const matchCat = categoryFilter === 'all' || p.category === categoryFilter;
    return matchText && matchCat;
  });

  if (filtered.length === 0) {
    // Show Empty State (Welcome Card if truly empty and not just filtered)
    if (!filterText && prompts.length === 0) {
      // This is the "Empty State" welcome card for new users (from previous task)
      // We can keep it or let the Pinned Card above serve the purpose.
      // If we have the pinned card, maybe we don't need this?
      // But the pinned card is mostly for "Logged In" state. 
      // Let's keep the empty state message simple if the Pinned Card is already there.
      if (!user_session) {
        grid.innerHTML += `
                <div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 40px;">
                    <p style="font-size: 1.2rem;">No prompts found.</p>
                    <p>Create one to get started!</p>
                </div>
             `;
      }
    } else {
      grid.innerHTML += `
            <div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 40px;">
                <p>No prompts found matching filter.</p>
            </div>
         `;
    }
    // Don't return if we added the pinned card! 
    if (!user_session && !filterText && prompts.length === 0) return;
    if (filtered.length === 0 && !document.querySelector('.pinned-guide-card')) return;
  }

  filtered.forEach((p, index) => {
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

    card.innerHTML = `
      <div class="card-header">
        <div class="card-title">${escapeHtml(p.title)}</div>
        <div class="card-actions">
           <button class="icon-btn fav-btn ${p.favorite ? 'active' : ''}" onclick="toggleFavorite('${p.id}')" title="Favorite">${favIcon}</button>
           <button class="icon-btn" onclick="copyPrompt('${p.id}')" title="Copy">${copyIcon}</button>
           <button class="icon-btn" onclick="openEditModal('${p.id}')" title="Edit">${editIcon}</button>
           <button class="icon-btn" onclick="deletePrompt('${p.id}')" title="Delete" style="color:var(--danger-color);">${trashIcon}</button>
        </div>
      </div>
      <div class="category-badge" style="margin-bottom:8px;">${p.category || 'other'}</div>
      <div class="card-body">${escapeHtml(p.body).substring(0, 150)}${p.body.length > 150 ? '...' : ''}</div>
      <div class="card-footer">
         <div class="tags">
            ${(p.tags || []).map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}
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

function copyPrompt(id) {
  const p = prompts.find(x => x.id === id);
  if (p) {
    navigator.clipboard.writeText(p.body);
    showToast('Copied to clipboard!');
  }
}

function openModal() {
  document.getElementById('promptId').value = '';
  promptForm.reset();
  document.getElementById('modalTitle').textContent = 'Add Prompt';
  document.getElementById('category').value = 'other';
  updateCategoryDropdownUI(modalCategoryDropdown, 'other');
  modalOverlay.classList.remove('hidden');
  setTimeout(() => modalOverlay.classList.add('visible'), 10);
}

function openEditModal(id) {
  const p = prompts.find(x => x.id === id);
  if (!p) return;
  document.getElementById('promptId').value = p.id;
  document.getElementById('title').value = p.title;
  document.getElementById('body').value = p.body;
  document.getElementById('tags').value = (p.tags || []).join(', ');
  document.getElementById('category').value = p.category || 'other';
  updateCategoryDropdownUI(modalCategoryDropdown, p.category || 'other');

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

document.addEventListener('DOMContentLoaded', () => NetworkManager.init());
