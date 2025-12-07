// app.js (UPDATED) - Supabase sync + offline queue + UI hooks + animations
// -----------------------------
// Uses window.SUPABASE_URL and window.SUPABASE_ANON_KEY and window.supabase (CDN)
// Make sure index.html includes:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js"></script>
// <script src="./cloudConfig.js"></script>  // defines window.SUPABASE_URL and window.SUPABASE_ANON_KEY
// <script src="./app.js"></script>         // this file
// -----------------------------

// Initialize Supabase using window variables
const supabase = window.supabase.createClient(
    window.SUPABASE_URL,
    window.SUPABASE_ANON_KEY
);

// Create or load device_id (acts like an account id — no login)
let device_id = localStorage.getItem("device_id");
if (!device_id) {
    device_id = crypto.randomUUID();
    localStorage.setItem("device_id", device_id);
}
console.log("device_id:", device_id);

// Offline queue stored in localStorage key "offlineQueue"
let offlineQueue = JSON.parse(localStorage.getItem('offlineQueue') || '[]');

// Local prompts are persisted in localStorage under key "prompts"
// We'll keep using that for instant UI and fallback when cloud fails

/* ---------- Cloud save / load / sync helpers ---------- */
async function savePromptToSupabase(prompt) {
  // prompt = { id, cloud_id?, title, body, tags, favorite, date }
  // If prompt.cloud_id exists -> update. Else -> insert and set cloud_id.
  try {
    if (prompt.cloud_id) {
      // Update existing row
      const { data, error } = await supabase
        .from("prompts")
        .update({
          title: prompt.title,
          body: prompt.body,
          tags: Array.isArray(prompt.tags) ? prompt.tags.join(",") : (prompt.tags || ""),
          favorite: !!prompt.favorite
        })
        .eq('id', prompt.cloud_id);

      if (error) {
        console.error("Cloud update failed:", error);
        // queue for offline
        queueOffline(prompt);
        return null;
      }
      return data && data[0] ? data[0] : null;
    } else {
      // Insert new row, include client id (local id) via metadata if possible
      const { data, error } = await supabase
        .from("prompts")
        .insert([{
          device_id: device_id,
          title: prompt.title || null,
          body: prompt.body || "",
          tags: Array.isArray(prompt.tags) ? prompt.tags.join(",") : (prompt.tags || ""),
          favorite: !!prompt.favorite
        }])
        .select(); // return inserted rows

      if (error) {
        console.error("Cloud insert failed:", error);
        queueOffline(prompt);
        return null;
      }

      // Supabase returns inserted row with id (uuid)
      const inserted = data && data[0];
      if (inserted) {
        // attach cloud_id to local prompt and persist localStorage
        prompt.cloud_id = inserted.id;
        // Save cloud_id locally (so future edits/deletes map)
        persistPromptCloudId(prompt.id, inserted.id);
      }
      return inserted;
    }
  } catch (err) {
    console.error("savePromptToSupabase error", err);
    queueOffline(prompt);
    return null;
  }
}

function queueOffline(prompt) {
  // Keep a minimal copy to re-send later
  const copy = {
    title: prompt.title,
    body: prompt.body,
    tags: Array.isArray(prompt.tags) ? prompt.tags.join(",") : (prompt.tags || ""),
    favorite: !!prompt.favorite,
    localId: prompt.id
  };
  offlineQueue.push(copy);
  localStorage.setItem('offlineQueue', JSON.stringify(offlineQueue));
}

/* Try to sync offline queue to Supabase */
async function syncOfflineQueue() {
  if (!offlineQueue || offlineQueue.length === 0) return;
  const queue = [...offlineQueue];
  for (const item of queue) {
    try {
      const { data, error } = await supabase
        .from("prompts")
        .insert([{
          device_id: device_id,
          title: item.title,
          body: item.body,
          tags: item.tags,
          favorite: item.favorite
        }])
        .select();

      if (error) {
        console.error("sync error:", error);
        // stop processing to avoid infinite loops when offline still
        return;
      }

      // On success, map returned id back to local prompt (if exists)
      const inserted = data && data[0];
      if (inserted) {
        // find local prompt by localId and attach cloud_id
        const pIndex = prompts.findIndex(p => p.id === item.localId);
        if (pIndex > -1) {
          prompts[pIndex].cloud_id = inserted.id;
        }
      }
      // remove item from offlineQueue
      offlineQueue = offlineQueue.filter(q => q.localId !== item.localId);
      localStorage.setItem('offlineQueue', JSON.stringify(offlineQueue));
    } catch (err) {
      console.error("syncOfflineQueue exception", err);
      return;
    }
  }
  // persist changes
  saveToLocalStorage();
  showToast("Offline prompts synced!");
}

/* Load prompts from cloud for this device id */
async function loadPromptsFromSupabaseAndMerge() {
  try {
    const { data, error } = await supabase
      .from("prompts")
      .select("*")
      .eq("device_id", device_id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("loadPromptsFromSupabase error:", error);
      // fallback to local prompts
      renderPrompts();
      return;
    }

    if (!Array.isArray(data) || data.length === 0) {
      // No cloud prompts — keep local prompts as-is
      renderPrompts();
      return;
    }

    // Merge strategy: prefer cloud items, but keep local-only items that aren't on cloud
    const cloudByBody = new Map();
    for (const row of data) {
      // convert to local prompt shape
      const local = {
        id: row.id, // use cloud uuid as id so local and cloud are same (safe)
        cloud_id: row.id,
        title: row.title || (autoGenerateTitle(row.body || "")),
        body: row.body || "",
        tags: (row.tags || "").toString().split(',').map(t => t.trim()).filter(Boolean),
        date: row.created_at || new Date().toISOString(),
        favorite: !!row.favorite,
      };
      cloudByBody.set(local.body, local);
    }

    // keep any local prompts that aren't matched by exact body
    const merged = [];
    const localPrompts = JSON.parse(localStorage.getItem('prompts') || '[]');

    // Add cloud prompts first
    for (const v of cloudByBody.values()) merged.push(v);

    // add local-only ones (by body mismatch)
    for (const lp of localPrompts) {
      if (!cloudByBody.has(lp.body)) {
        // ensure it has an id
        if (!lp.id) lp.id = Date.now().toString();
        merged.push(lp);
      }
    }

    prompts = merged;
    saveToLocalStorage();
    renderPrompts();

  } catch (err) {
    console.error("loadPromptsFromSupabaseAndMerge exception", err);
    renderPrompts(); // fallback
  }
}

/* Persist cloud_id to local prompt (helper) */
function persistPromptCloudId(localId, cloudId) {
  try {
    const idx = prompts.findIndex(p => p.id === localId);
    if (idx > -1) {
      prompts[idx].cloud_id = cloudId;
      // Optionally replace local id with cloud id (to simplify) — but we keep local id as-is to avoid UI mismatch
      saveToLocalStorage();
    }
  } catch (e) {
    console.error("persistPromptCloudId failed", e);
  }
}

/* Save cloud set to local storage (overwrite) */
function saveCloudToLocal(cloudRows) {
  const mapped = cloudRows.map(row => ({
    id: row.id,
    cloud_id: row.id,
    title: row.title || autoGenerateTitle(row.body || ""),
    body: row.body || "",
    tags: (row.tags || "").toString().split(',').map(t => t.trim()).filter(Boolean),
    date: row.created_at || new Date().toISOString(),
    favorite: !!row.favorite
  }));
  prompts = mapped;
  saveToLocalStorage();
}

/* ---------- End cloud helpers ---------- */

/* ---------- Existing app code (slightly adapted) ---------- */

// We'll keep prompts and categories in top-level scope so cloud functions can update them
let prompts = JSON.parse(localStorage.getItem('prompts')) || [];
let categories = JSON.parse(localStorage.getItem('categories')) || ['coding', 'writing', 'art', 'email', 'youtube', 'marketing', 'research', 'other'];

/* DOM-ready initialization */
document.addEventListener('DOMContentLoaded', () => {
    // Theme Initialization
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    let currentTheme = savedTheme;

    // If no prompts, add welcome
    if (prompts.length === 0) {
        prompts = [{
            id: 'welcome-guide',
            title: '✨ Welcome to Prompit Saver!',
            category: 'other',
            body: "👋 Hi there! Here's how to use your new organizer:\n\n1. ➕ Click the floating button (bottom-right) to add a new prompt.\n2. 🚀 Use the 'Quick Paste' box above for instant saving.\n3. ⭐ Click the Star icon to favorite your best prompts.\n4. 🔍 Use the Search bar to find prompts instantly.\n5. 💾 Export your data to JSON for backup.\n\nTry editing or deleting this prompt to get started!",
            tags: ['welcome', 'tutorial', 'start-here'],
            date: new Date().toISOString(),
            favorite: true
        }];
        localStorage.setItem('prompts', JSON.stringify(prompts));
    }

    // DOM Elements
    const promptGrid = document.getElementById('promptGrid');
    const fab = document.getElementById('fab');
    const modalOverlay = document.getElementById('modalOverlay');
    const closeModal = document.getElementById('closeModal');
    const promptForm = document.getElementById('promptForm');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    const modalTags = document.getElementById('modalTags');
    const modalCategory = document.getElementById('modalCategory');
    const autoFillBtn = document.getElementById('autoFillBtn');
    const searchInput = document.getElementById('searchInput');
    const customCategoryDropdown = document.getElementById('customCategoryDropdown');
    const dropdownSelected = customCategoryDropdown.querySelector('.dropdown-selected');
    const dropdownOptions = customCategoryDropdown.querySelector('.dropdown-options');
    let currentCategory = 'all';

    const modalCategoryDropdown = document.getElementById('modalCategoryDropdown');
    const modalDropdownSelected = modalCategoryDropdown.querySelector('.dropdown-selected');
    const modalDropdownOptions = modalCategoryDropdown.querySelector('.dropdown-options');
    const categoryInput = document.getElementById('category');
    const quickPaste = document.getElementById('quickPaste');
    const quickAddBtn = document.getElementById('quickAddBtn');
    const toast = document.getElementById('toast');
    const fileInput = document.getElementById('fileInput');

    const settingsBtn = document.getElementById('settingsBtn');
    const settingsDropdown = document.getElementById('settingsDropdown');
    const themeOption = document.getElementById('themeOption');
    const exportOption = document.getElementById('exportOption');
    const importOption = document.getElementById('importOption');

    // Icons
    const icons = {
        copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
        edit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
        trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
        star: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>'
    };

    // Initial Render
    renderCategoryOptions();
    renderPrompts();

    // Onboarding: Pulse FAB if welcome prompt is present
    if (prompts.some(p => p.id === 'welcome-guide')) {
        fab.classList.add('pulse-animation');
        setTimeout(() => fab.classList.remove('pulse-animation'), 5000);
        fab.addEventListener('click', () => fab.classList.remove('pulse-animation'), { once: true });
    }

    // Event Listeners
    fab.addEventListener('click', () => openModal());
    closeModal.addEventListener('click', closeModalFunc);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModalFunc();
    });
    promptForm.addEventListener('submit', handleFormSubmit);
    searchInput.addEventListener('input', renderPrompts);

    dropdownSelected.addEventListener('click', (e) => {
        e.stopPropagation();
        customCategoryDropdown.classList.toggle('open');
    });

    dropdownOptions.addEventListener('click', (e) => {
        const option = e.target.closest('.dropdown-option');
        if (!option) return;
        e.stopPropagation();
        const value = option.dataset.value;
        const text = option.textContent;

        currentCategory = value;
        dropdownSelected.textContent = text;
        customCategoryDropdown.classList.remove('open');

        const allOptions = dropdownOptions.querySelectorAll('.dropdown-option');
        allOptions.forEach(item => item.classList.remove('selected'));
        option.classList.add('selected');

        renderPrompts();
    });

    modalDropdownSelected.addEventListener('click', (e) => {
        e.stopPropagation();
        modalCategoryDropdown.classList.toggle('open');
    });

    modalDropdownOptions.addEventListener('click', (e) => {
        const option = e.target.closest('.dropdown-option');
        if (!option) return;
        e.stopPropagation();
        const value = option.dataset.value;
        const text = option.textContent;

        if (value === 'new-category') {
            const newCat = prompt('Enter new category name:');
            if (newCat && newCat.trim()) {
                const formattedCat = newCat.trim().toLowerCase();
                if (!categories.includes(formattedCat)) {
                    categories.push(formattedCat);
                    saveCategories();
                    renderCategoryOptions();
                }
                categoryInput.value = formattedCat;
                modalDropdownSelected.textContent = formattedCat.charAt(0).toUpperCase() + formattedCat.slice(1);

                const allOptions = modalDropdownOptions.querySelectorAll('.dropdown-option');
                allOptions.forEach(item => item.classList.remove('selected'));
                const newOption = modalDropdownOptions.querySelector(`[data-value="${formattedCat}"]`);
                if (newOption) newOption.classList.add('selected');
            }
        } else {
            categoryInput.value = value;
            modalDropdownSelected.textContent = text;

            const allOptions = modalDropdownOptions.querySelectorAll('.dropdown-option');
            allOptions.forEach(item => item.classList.remove('selected'));
            option.classList.add('selected');
        }

        modalCategoryDropdown.classList.remove('open');
    });

    document.addEventListener('click', (e) => {
        if (!customCategoryDropdown.contains(e.target)) {
            customCategoryDropdown.classList.remove('open');
        }
        if (!modalCategoryDropdown.contains(e.target)) {
            modalCategoryDropdown.classList.remove('open');
        }
    });
    quickAddBtn.addEventListener('click', handleQuickAdd);

    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        settingsDropdown.classList.toggle('open');
    });

    themeOption.addEventListener('click', () => {
        toggleTheme();
        settingsDropdown.classList.remove('open');
    });

    exportOption.addEventListener('click', () => {
        exportData();
        settingsDropdown.classList.remove('open');
    });

    importOption.addEventListener('click', () => {
        fileInput.click();
        settingsDropdown.classList.remove('open');
    });

    document.addEventListener('click', (e) => {
        if (!settingsDropdown.contains(e.target)) {
            settingsDropdown.classList.remove('open');
        }
    });

    autoFillBtn.addEventListener('click', handleAutoFill);

    const footer = document.querySelector('.app-footer');
    const aboutSection = document.querySelector('.about-section');

    if (fab) {
        const observer = new IntersectionObserver((entries) => {
            const isIntersecting = entries.some(entry => entry.isIntersecting);

            if (isIntersecting) {
                fab.classList.add('up');
                fab.classList.add('rectangular');
            } else {
                fab.classList.remove('up');
                fab.classList.remove('rectangular');
            }
        }, { threshold: 0.1 });

        if (footer) observer.observe(footer);
        if (aboutSection) observer.observe(aboutSection);
    }

    // Functions (localStorage helpers & UI)
    function saveToLocalStorage() {
        localStorage.setItem('prompts', JSON.stringify(prompts));
    }

    function saveCategories() {
        localStorage.setItem('categories', JSON.stringify(categories));
    }

    function toggleTheme() {
        currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', currentTheme);
        localStorage.setItem('theme', currentTheme);
        updateThemeUI();
    }

    function updateThemeUI() {
        const textSpan = themeOption.querySelector('.text');
        const iconSpan = themeOption.querySelector('.icon');

        if (currentTheme === 'dark') {
            textSpan.textContent = 'Switch to Light Mode';
            iconSpan.textContent = '☀️';
        } else {
            textSpan.textContent = 'Switch to Dark Mode';
            iconSpan.textContent = '🌙';
        }
    }

    function renderCategoryOptions() {
        const currentVal = categoryInput.value;
        modalDropdownOptions.innerHTML = '';

        categories.forEach(cat => {
            const div = document.createElement('div');
            div.className = 'dropdown-option';
            div.dataset.value = cat;
            div.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
            if (currentVal === cat) div.classList.add('selected');
            modalDropdownOptions.appendChild(div);
        });

        const addNew = document.createElement('div');
        addNew.className = 'dropdown-option';
        addNew.style.borderTop = '1px solid rgba(0,0,0,0.1)';
        addNew.style.marginTop = '5px';
        addNew.style.color = 'var(--primary-color)';
        addNew.style.fontWeight = '600';
        addNew.dataset.value = 'new-category';
        addNew.textContent = '+ Add New Category';
        modalDropdownOptions.appendChild(addNew);

        if (categories.includes(currentVal)) {
            categoryInput.value = currentVal;
            modalDropdownSelected.textContent = currentVal.charAt(0).toUpperCase() + currentVal.slice(1);
        } else if (categories.length > 0 && !currentVal) {
            categoryInput.value = categories[0];
            modalDropdownSelected.textContent = categories[0].charAt(0).toUpperCase() + categories[0].slice(1);
        }

        const dropdownOptionsContainer = document.querySelector('#customCategoryDropdown .dropdown-options');
        dropdownOptionsContainer.innerHTML = '';

        const allDiv = document.createElement('div');
        allDiv.className = 'dropdown-option';
        if (currentCategory === 'all') allDiv.classList.add('selected');
        allDiv.dataset.value = 'all';
        allDiv.textContent = 'All Categories';
        dropdownOptionsContainer.appendChild(allDiv);

        categories.forEach(cat => {
            const div = document.createElement('div');
            div.className = 'dropdown-option';
            if (currentCategory === cat) div.classList.add('selected');
            div.dataset.value = cat;
            div.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
            dropdownOptionsContainer.appendChild(div);
        });
    }

    function handleAutoFill() {
        const text = modalBody.value.trim();
        if (!text) {
            showToast('Please enter some text in the body first.');
            return;
        }

        const analysis = analyzePrompt(text);

        document.getElementById('title').value = analysis.title;
        document.getElementById('tags').value = analysis.tags.join(', ');

        document.getElementById('category').value = analysis.category;
        const dropdown = document.getElementById('modalCategoryDropdown');
        const selectedDisplay = dropdown.querySelector('.dropdown-selected');
        selectedDisplay.textContent = analysis.category.charAt(0).toUpperCase() + analysis.category.slice(1);

        dropdown.querySelectorAll('.dropdown-option').forEach(opt => {
            if (opt.dataset.value === analysis.category) {
                opt.classList.add('selected');
            } else {
                opt.classList.remove('selected');
            }
        });

        showToast('Auto-filled metadata!');
    }

    function renderPrompts() {
        promptGrid.innerHTML = '';

        const searchTerm = searchInput.value.toLowerCase();
        const category = currentCategory;

        const filteredPrompts = prompts.filter(p => {
            const matchesSearch = (p.title || '').toLowerCase().includes(searchTerm) ||
                (p.body || '').toLowerCase().includes(searchTerm) ||
                (Array.isArray(p.tags) ? p.tags : (p.tags||"")).join(' ').toLowerCase().includes(searchTerm);
            const matchesCategory = category === 'all' || p.category === category;
            return matchesSearch && matchesCategory;
        });

        filteredPrompts.sort((a, b) => {
            if ((a.favorite ? 1 : 0) === (b.favorite ? 1 : 0)) {
                return new Date(b.date) - new Date(a.date);
            }
            return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
        });

        if (filteredPrompts.length === 0) {
            promptGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #666; padding: 40px;">No prompts found. Add one to get started!</div>';
            return;
        }

        filteredPrompts.forEach(prompt => {
            const card = document.createElement('div');
            card.className = 'prompt-card';
            card.setAttribute('data-id', prompt.id);

            const tagsHtml = (Array.isArray(prompt.tags) ? prompt.tags : (prompt.tags||[])).map(tag => `<span class="tag">#${tag}</span>`).join('');

            card.innerHTML = `
                <div class="card-header">
                    <div class="card-title">${escapeHtml(prompt.title)}</div>
                    <div class="card-actions">
                        <button class="icon-btn fav-btn ${prompt.favorite ? 'active' : ''}" data-fav="${prompt.id}" title="Toggle Favorite">
                            ${icons.star}
                        </button>
                        <button class="icon-btn" data-copy="${prompt.id}" title="Copy">
                            ${icons.copy}
                        </button>
                        <button class="icon-btn" data-edit="${prompt.id}" title="Edit">
                            ${icons.edit}
                        </button>
                        <button class="icon-btn" data-delete="${prompt.id}" title="Delete" style="color: var(--danger-color)">
                            ${icons.trash}
                        </button>
                    </div>
                </div>
                <div class="category-badge">${escapeHtml(prompt.category || '')}</div>
                <div class="card-body">${escapeHtml(prompt.body)}</div>
                <div class="card-footer">
                    <div class="tags">${tagsHtml}</div>
                </div>
            `;
            // Attach event listeners (delegated)
            card.querySelector('[data-copy]').addEventListener('click', () => window.copyPrompt(prompt.id));
            card.querySelector('[data-edit]').addEventListener('click', () => window.editPrompt(prompt.id));
            card.querySelector('[data-delete]').addEventListener('click', () => window.deletePrompt(prompt.id));
            card.querySelector('[data-fav]').addEventListener('click', () => window.toggleFavorite(prompt.id));

            promptGrid.appendChild(card);
        });
    }

    function openModal(prompt = null) {
        modalOverlay.classList.remove('hidden');
        setTimeout(() => modalOverlay.classList.add('visible'), 10);

        if (prompt) {
            modalTitle.textContent = 'Edit Prompt';
            document.getElementById('promptId').value = prompt.id;
            document.getElementById('title').value = prompt.title;

            categoryInput.value = prompt.category;
            modalDropdownSelected.textContent = prompt.category.charAt(0).toUpperCase() + prompt.category.slice(1);
            const options = modalDropdownOptions.querySelectorAll('.dropdown-option');
            options.forEach(opt => {
                if (opt.dataset.value === prompt.category) opt.classList.add('selected');
                else opt.classList.remove('selected');
            });

            document.getElementById('body').value = prompt.body;
            document.getElementById('tags').value = (Array.isArray(prompt.tags) ? prompt.tags.join(', ') : prompt.tags);
        } else {
            modalTitle.textContent = 'Add Prompt';
            promptForm.reset();
            document.getElementById('promptId').value = '';

            if (categories.length > 0) {
                categoryInput.value = categories[0];
                modalDropdownSelected.textContent = categories[0].charAt(0).toUpperCase() + categories[0].slice(1);
                const options = modalDropdownOptions.querySelectorAll('.dropdown-option');
                options.forEach(opt => {
                    if (opt.dataset.value === categories[0]) opt.classList.add('selected');
                    else opt.classList.remove('selected');
                });
            }
        }
    }

    function closeModalFunc() {
        modalOverlay.classList.remove('visible');
        setTimeout(() => modalOverlay.classList.add('hidden'), 300);
    }

    async function handleFormSubmit(e) {
        e.preventDefault();
        const id = document.getElementById('promptId').value;
        const title = document.getElementById('title').value;
        const category = document.getElementById('category').value;
        const body = document.getElementById('body').value;
        const tags = document.getElementById('tags').value.split(',').map(t => t.trim()).filter(t => t);

        const promptData = {
            id: id || Date.now().toString(),
            title: title || autoGenerateTitle(body),
            category,
            body,
            tags,
            date: new Date().toISOString(),
            favorite: id ? (prompts.find(p => p.id === id)?.favorite || false) : false
        };

        if (id) {
            const index = prompts.findIndex(p => p.id === id);
            prompts[index] = { ...prompts[index], ...promptData };
        } else {
            prompts.unshift(promptData);
        }

        // Persist locally immediately for instant UI
        saveToLocalStorage();
        renderPrompts();
        closeModalFunc();
        showToast('Prompt saved!');

        // Try to save to cloud in background
        // If it fails, savePromptToSupabase will queue it for offline sync
        savePromptToSupabase(promptData).then(res => {
          if (res && res.id) {
            // attach cloud id locally if inserted
            const idx = prompts.findIndex(p => p.id === promptData.id);
            if (idx > -1) {
              prompts[idx].cloud_id = res.id;
              saveToLocalStorage();
            }
          }
        });
    }

    // Smart Prompt Extraction Logic (unchanged)
    function analyzePrompt(text) {
        const lowerText = text.toLowerCase();
        let category = 'other';
        let tags = [];
        let isLikelyFavorite = false;

        if (/(code|function|bug|js|python|java|html|css|react|node)/i.test(text)) category = 'coding';
        else if (/(email|cold email|outreach|newsletter|subject line)/i.test(text)) category = 'email';
        else if (/(youtube|video|thumbnail|hook|channel)/i.test(text) || (/(script)/i.test(text) && /(youtube|video)/i.test(text))) category = 'youtube';
        else if (/(ad|facebook|instagram|caption|marketing|seo|copy)/i.test(text)) category = 'marketing';
        else if (/(summarize|analysis|research|study|paper|data)/i.test(text)) category = 'research';
        else if (/(art|image|draw|paint|design|logo)/i.test(text)) category = 'art';
        else if (/(write|story|article|blog|script|essay|poem)/i.test(text)) category = 'writing';
        else category = 'other';

        const possibleTags = ['youtube', 'script', 'fitness', 'hindi', 'coding', 'python', 'js', 'email', 'marketing', 'blog', 'story', 'research', 'summary', 'bug', 'fix'];
        possibleTags.forEach(tag => {
            if (lowerText.includes(tag)) {
                tags.push(tag);
            }
        });
        if (tags.length === 0) tags.push(category);
        if (tags.length < 2 && category !== 'other') tags.push('prompt');
        tags = tags.slice(0, 5);

        let cleanText = text.replace(/^(write a|create a|act as a|generate a|give me a)\s+/i, '');
        let words = cleanText.split(/\s+/);
        let title = words.slice(0, 6).join(' ');
        if (words.length > 6) title += '...';
        title = title.replace(/\b\w/g, l => l.toUpperCase());

        let autoShortTitle = words.slice(0, 2).join(' ').replace(/\b\w/g, l => l.toUpperCase());

        if (text.length > 100 || /(advanced|framework|master|guide|comprehensive)/i.test(text)) {
            isLikelyFavorite = true;
        }

        return {
            title,
            category,
            tags,
            autoShortTitle,
            isLikelyFavorite
        };
    }

    function handleQuickAdd() {
        const text = quickPaste.value.trim();
        if (!text) return;

        const analysis = analyzePrompt(text);

        const newPrompt = {
            id: Date.now().toString(),
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
        showToast('Prompt added with Smart Extraction!');

        // Try cloud save in background
        savePromptToSupabase(newPrompt).then(res => {
          if (res && res.id) {
            const idx = prompts.findIndex(p => p.id === newPrompt.id);
            if (idx > -1) {
              prompts[idx].cloud_id = res.id;
              saveToLocalStorage();
            }
          }
        });
    }

    function autoGenerateTitle(text) {
        const words = text.split(/\s+/);
        return words.slice(0, 4).join(' ') + (words.length > 4 ? '...' : '');
    }

    // Toast (simple)
    function showToast(message) {
        const toastMsg = document.getElementById('toastMessage');
        toastMsg.textContent = message;
        toast.classList.add('visible');
        setTimeout(() => {
            toast.classList.remove('visible');
        }, 3000);
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function exportData() {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(prompts));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "prompts_backup.json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    }

    async function importData(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!confirm('This will merge imported prompts with your current ones. Continue?')) {
            fileInput.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = async function (e) {
            try {
                const importedPrompts = JSON.parse(e.target.result);
                if (Array.isArray(importedPrompts)) {
                    const currentIds = new Set(prompts.map(p => p.id));
                    let addedCount = 0;

                    for (const p of importedPrompts) {
                        if (!currentIds.has(p.id)) {
                            // insert locally
                            prompts.push(p);
                            addedCount++;
                            // try save to cloud as background (attach local id)
                            savePromptToSupabase(p).then(res => {
                              if (res && res.id) {
                                const idx = prompts.findIndex(x => x.id === p.id);
                                if (idx > -1) {
                                  prompts[idx].cloud_id = res.id;
                                  saveToLocalStorage();
                                }
                              }
                            });
                        }
                    }

                    saveToLocalStorage();
                    renderPrompts();
                    showToast(`Imported ${addedCount} prompts!`);
                } else {
                    alert('Invalid JSON format');
                }
            } catch (err) {
                alert('Error reading file');
                console.error(err);
            }
            fileInput.value = '';
        };
        reader.readAsText(file);
    }

    // Expose functions to global scope for inline onclick handlers
    window.deletePrompt = async function (id) {
        if (!confirm('Are you sure you want to delete this prompt?')) return;
        // find the prompt
        const prompt = prompts.find(p => p.id === id);
        if (!prompt) return;
        // If cloud_id exists, delete from cloud
        if (prompt.cloud_id) {
          try {
            const { error } = await supabase.from('prompts').delete().eq('id', prompt.cloud_id);
            if (error) {
              console.error('Cloud delete failed', error);
              showToast('Could not delete from cloud, deleted locally.');
            }
          } catch (err) {
            console.error('delete exception', err);
            showToast('Network error while deleting. Deleted locally.');
          }
        }
        // Remove locally
        prompts = prompts.filter(p => p.id !== id);
        saveToLocalStorage();
        renderPrompts();
        showToast('Prompt deleted');
    };

    window.editPrompt = function (id) {
        const prompt = prompts.find(p => p.id === id);
        if (prompt) openModal(prompt);
    };

    window.toggleFavorite = async function (id) {
        const prompt = prompts.find(p => p.id === id);
        if (prompt) {
            prompt.favorite = !prompt.favorite;
            saveToLocalStorage();
            renderPrompts();
            // Update cloud if possible
            if (prompt.cloud_id) {
              try {
                const { error } = await supabase.from('prompts').update({ favorite: prompt.favorite }).eq('id', prompt.cloud_id);
                if (error) {
                  console.error('favorite update failed', error);
                  queueOffline(prompt);
                }
              } catch (err) {
                console.error(err);
                queueOffline(prompt);
              }
            } else {
              // attempt to save as new entry on cloud
              savePromptToSupabase(prompt).then(res => {
                if (res && res.id) {
                  prompt.cloud_id = res.id;
                  saveToLocalStorage();
                }
              });
            }
        }
    };

    window.copyPrompt = function (id) {
        const prompt = prompts.find(p => p.id === id);
        if (prompt) {
            navigator.clipboard.writeText(prompt.body).then(() => {
                showToast('Copied to clipboard!');
            });
        }
    };

    // Sync offline queue on load and subscribe to realtime updates
    (async function startupSync() {
      // first try to sync any offline queued items
      await syncOfflineQueue();
      // then load cloud prompts and merge
      await loadPromptsFromSupabaseAndMerge();

      // subscribe to realtime changes for live sync (optional)
      try {
        const channel = supabase
          .channel('public:prompts')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'prompts' }, payload => {
            // If change affects this device, reload
            // simple approach: refresh full list
            loadPromptsFromSupabaseAndMerge();
          })
          .subscribe();
      } catch (e) {
        console.warn('Realtime subscribe failed (not critical)', e);
      }
    })();

    // Wire up file import input
    fileInput.addEventListener('change', importData);

}); // DOMContentLoaded end
