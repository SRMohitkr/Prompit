/* app.js — PATCHED
   - Fixes category propagation to local storage and Supabase (insert/update/sync)
   - Ensures consistent localStorage key ("prompt_saves") everywhere
   - Ensures offline-queue sync includes category
   - Keeps all original UI hooks, animations, and behavior intact
   - Minimal, surgical changes only (no unrelated removals)
*/

(() => {
  // ---------- Supabase client ----------
  const supabase = (window.supabase && window.SUPABASE_URL && window.SUPABASE_ANON_KEY)
    ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
    : (window.supabase ? window.supabase.createClient(window.SUPABASE_URL || '', window.SUPABASE_ANON_KEY || '') : null);

  if (!supabase) {
    console.warn('Supabase not initialized. cloud sync will be disabled until cloudConfig.js is provided.');
  }

  // ---------- device id ----------
  let device_id = localStorage.getItem('device_id');
  if (!device_id) {
    device_id = crypto.randomUUID();
    localStorage.setItem('device_id', device_id);
  }
  console.log('device_id:', device_id);

  // ---------- state ----------
  // Standardize on "prompt_saves" localStorage key everywhere
  let prompts = JSON.parse(localStorage.getItem('prompt_saves') || '[]');
  let categories = JSON.parse(localStorage.getItem('categories') || '[]');
  if (!Array.isArray(categories) || categories.length === 0) {
    categories = ['coding', 'writing', 'art', 'email', 'youtube', 'marketing', 'research', 'other'];
  }

  let offlineQueue = JSON.parse(localStorage.getItem('offlineQueue') || '[]');

  // Theme state
  let currentTheme = localStorage.getItem('theme') || 'light';
  function applyTheme(theme) {
    currentTheme = theme;
    localStorage.setItem('theme', theme);
    if (theme === 'dark') document.body.classList.add('dark-mode');
    else document.body.classList.remove('dark-mode');
    updateThemeUI();
  }
  function toggleTheme() {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  }
  function updateThemeUI() {
    const themeOptionEl = document.getElementById('themeOption');
    if (!themeOptionEl) return;
    const icon = themeOptionEl.querySelector('.icon');
    const text = themeOptionEl.querySelector('.text');
    if (currentTheme === 'dark') {
      if (icon) icon.textContent = '☀️';
      if (text) text.textContent = 'Light Mode';
    } else {
      if (icon) icon.textContent = '🌙';
      if (text) text.textContent = 'Dark Mode';
    }
  }
  applyTheme(currentTheme);

  // ---------- helpers ----------
  function saveToLocalStorage() {
    // ensure category always present on every prompt
    prompts = (prompts || []).map(p => ({ ...p, category: p.category || 'other' }));
    localStorage.setItem('prompt_saves', JSON.stringify(prompts));
  }
  function saveCategories() {
    localStorage.setItem('categories', JSON.stringify(categories));
    syncCategoriesToCloud();
  }

  async function syncCategoriesToCloud() {
    if (!supabase || !device_id) return;
    try {
      const { error } = await supabase
        .from('device_metadata')
        .upsert({
          device_id: device_id,
          categories: JSON.stringify(categories),
          updated_at: new Date().toISOString()
        }, { onConflict: 'device_id' });
      if (error) console.warn('Failed to sync categories to cloud:', error);
      else console.log('Categories synced to cloud');
    } catch (err) {
      console.warn('Category sync exception:', err);
    }
  }

  async function loadCategoriesFromCloud() {
    if (!supabase || !device_id) return;
    try {
      const { data, error } = await supabase
        .from('device_metadata')
        .select('categories')
        .eq('device_id', device_id)
        .single();
      if (error) {
        // not critical
        return;
      }
      if (data && data.categories) {
        const cloudCategories = JSON.parse(data.categories);
        if (Array.isArray(cloudCategories) && cloudCategories.length > 0) {
          categories = cloudCategories;
          saveCategories(); // persist locally and (re)sync UI
          console.log('Categories loaded from cloud');
        }
      }
    } catch (err) {
      console.warn('Category load exception:', err);
    }
  }

  function showToast(message) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMessage');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = message;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 3000);
  }
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  function autoGenerateTitle(text) {
    const words = (text || '').split(/\s+/).filter(Boolean);
    if (words.length === 0) return 'Untitled';
    return words.slice(0, 4).join(' ') + (words.length > 4 ? '...' : '');
  }
  function analyzePrompt(text) {
    const lowerText = (text || '').toLowerCase();
    let category = 'other';
    if (/(code|function|bug|js|python|java|html|css|react|node)/i.test(text)) category = 'coding';
    else if (/(email|cold email|outreach|newsletter|subject line)/i.test(text)) category = 'email';
    else if (/(youtube|video|thumbnail|hook|channel)/i.test(text)) category = 'youtube';
    else if (/(ad|facebook|instagram|caption|marketing|seo|copy)/i.test(text)) category = 'marketing';
    else if (/(summarize|analysis|research|study|paper|data)/i.test(text)) category = 'research';
    else if (/(art|image|draw|paint|design|logo)/i.test(text)) category = 'art';
    else if (/(write|story|article|blog|script|essay|poem)/i.test(text)) category = 'writing';
    const possibleTags = ['youtube','script','fitness','hindi','coding','python','js','email','marketing','blog','story','research','summary','bug','fix'];
    const tags = [];
    possibleTags.forEach(tag => { if (lowerText.includes(tag)) tags.push(tag); });
    if (tags.length === 0) tags.push(category);
    if (tags.length < 2 && category !== 'other') tags.push('prompt_saves');
    return {
      title: autoGenerateTitle(text),
      category,
      tags: tags.slice(0,5),
      autoShortTitle: (text||'').split(/\s+/).slice(0,2).join(' '),
      isLikelyFavorite: text.length > 100 || /(advanced|framework|master|guide|comprehensive)/i.test(text)
    };
  }

  // ---------- offline queue ----------
  function queueOffline(prompt) {
    const copy = {
      title: prompt.title,
      body: prompt.body,
      tags: Array.isArray(prompt.tags) ? prompt.tags.join(',') : (prompt.tags || ''),
      favorite: !!prompt.favorite,
      category: prompt.category || 'other',
      localId: prompt.id
    };
    offlineQueue.push(copy);
    localStorage.setItem('offlineQueue', JSON.stringify(offlineQueue));
  }

  async function syncOfflineQueue() {
    offlineQueue = JSON.parse(localStorage.getItem('offlineQueue') || '[]');
    if (!supabase || !offlineQueue.length) return;
    const queue = [...offlineQueue];
    for (const item of queue) {
      try {
        const { data, error } = await supabase
          .from("prompt_saves")
          .insert([
            {
              device_id,
              title: item.title,
              body: item.body,
              tags: item.tags,
              favorite: item.favorite,
              category: item.category || 'other'
            }
          ])
          .select()
          .single();
        if (error) {
          console.error('sync error:', error);
          return;
        }
        const idx = prompts.findIndex(p => p.id === item.localId);
        if (idx > -1) prompts[idx].cloud_id = data.id;
        offlineQueue = offlineQueue.filter(q => q.localId !== item.localId);
        localStorage.setItem('offlineQueue', JSON.stringify(offlineQueue));
      } catch (err) {
        console.error('syncOfflineQueue exception', err);
        return;
      }
    }
    saveToLocalStorage();
    showToast('Offline prompts synced!');
  }

  // ---------- cloud helpers ----------
  async function savePromptToSupabase(prompt) {
    if (!supabase) {
      queueOffline(prompt);
      return null;
    }
    try {
      // ensure category is present
      const categoryVal = prompt.category || 'other';
      if (prompt.cloud_id) {
        // UPDATE
        const { data, error } = await supabase
          .from("prompt_saves")
          .update({
            title: prompt.title,
            body: prompt.body,
            tags: Array.isArray(prompt.tags) ? prompt.tags.join(",") : (prompt.tags || ""),
            favorite: !!prompt.favorite,
            category: categoryVal
          })
          .eq("id", prompt.cloud_id)
          .select()
          .single();
        if (error) {
          console.error("Cloud update failed:", error);
          queueOffline(prompt);
          return null;
        }
        return data;
      } else {
        // INSERT
        const { data, error } = await supabase
          .from("prompt_saves")
          .insert([
            {
              device_id: device_id,
              title: prompt.title,
              body: prompt.body,
              tags: Array.isArray(prompt.tags) ? prompt.tags.join(",") : (prompt.tags || ""),
              favorite: !!prompt.favorite,
              category: categoryVal
            }
          ])
          .select()
          .single();
        if (error) {
          console.error("Cloud insert failed:", error);
          queueOffline(prompt);
          return null;
        }
        prompt.cloud_id = data.id;
        persistPromptCloudId(prompt.id, data.id);
        return data;
      }
    } catch (err) {
      console.error("savePromptToSupabase error:", err);
      queueOffline(prompt);
      return null;
    }
  }

  async function testSupabaseConnection() {
    if (!supabase) {
      console.warn('Supabase not configured (test skipped)');
      showToast('Cloud: not configured');
      return false;
    }
    try {
      const { data, error } = await supabase.from('prompt_saves').select('id').limit(1);
      if (error) {
        console.error('Cloud test failed', error);
        showToast('Cloud test failed');
        return false;
      }
      console.info('Cloud reachable, sample rows:', (data && data.length) || 0);
      showToast('Cloud OK');
      return true;
    } catch (e) {
      console.error('Cloud test exception', e);
      showToast('Cloud test error');
      return false;
    }
  }

  async function loadPromptsFromSupabaseAndMerge() {
    if (!supabase) {
      // still read from local storage
      prompts = JSON.parse(localStorage.getItem('prompt_saves') || '[]');
      renderPrompts();
      return;
    }
    try {
      const { data, error } = await supabase
        .from("prompt_saves")
        .select("*")
        .eq("device_id", device_id)
        .order("created_at", { ascending: false });
      if (error) {
        console.error("loadPromptsFromSupabase error:", error);
        renderPrompts();
        return;
      }
      if (!Array.isArray(data)) {
        renderPrompts();
        return;
      }
      const cloudMap = new Map();
      for (const row of data) {
        cloudMap.set(row.id, {
          id: row.id,
          cloud_id: row.id,
          title: row.title || autoGenerateTitle(row.body || ""),
          body: row.body || "",
          tags: (row.tags || "").toString().split(",").map(t => t.trim()).filter(Boolean),
          favorite: !!row.favorite,
          date: row.created_at || new Date().toISOString(),
          category: row.category || 'other'
        });
      }
      const merged = [];
      cloudMap.forEach(v => merged.push(v));
      // Add local-only (use same storage key)
      const localPrompts = JSON.parse(localStorage.getItem("prompt_saves") || "[]");
      for (const p of localPrompts) {
        // If local prompt doesn't have cloud_id and isn't in cloud by identical body, keep it
        if (!p.cloud_id && ![...cloudMap.values()].some(c => c.body === p.body)) merged.push(p);
      }
      prompts = merged.map(p => ({ ...p, category: p.category || 'other' }));
      saveToLocalStorage();
      renderPrompts();
    } catch (err) {
      console.error("loadPromptsFromSupabase exception:", err);
      renderPrompts();
    }
  }

  function persistPromptCloudId(localId, cloudId) {
    try {
      const idx = prompts.findIndex(p => p.id === localId);
      if (idx > -1) {
        prompts[idx].cloud_id = cloudId;
        saveToLocalStorage();
      }
    } catch (e) {
      console.error('persistPromptCloudId failed', e);
    }
  }

  // ---------- UI rendering & handlers ----------
  function renderPrompts() {
    const promptGrid = document.getElementById('promptGrid');
    const searchInput = document.getElementById('searchInput');
    if (!promptGrid) return;
    promptGrid.innerHTML = '';
    const searchTerm = (searchInput && searchInput.value || '').toLowerCase();
    const categoryDrop = document.querySelector('#customCategoryDropdown .dropdown-selected');
    const currentCategory = categoryDrop ? (categoryDrop.dataset?.value || 'all') : 'all';

    const filteredPrompts = prompts.filter(p => {
      const matchesSearch = (p.title || '').toLowerCase().includes(searchTerm) ||
        (p.body || '').toLowerCase().includes(searchTerm) ||
        (Array.isArray(p.tags) ? p.tags : (p.tags||[])).join(' ').toLowerCase().includes(searchTerm);
      const matchesCategory = currentCategory === 'all' || (p.category || 'other') === currentCategory;
      return matchesSearch && matchesCategory;
    });

    filteredPrompts.sort((a,b) => {
      if ((a.favorite?1:0) === (b.favorite?1:0)) return new Date(b.date) - new Date(a.date);
      return (b.favorite?1:0) - (a.favorite?1:0);
    });

    if (filteredPrompts.length === 0) {
      promptGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#666;padding:40px">No prompts found. Add one to get started!</div>';
      return;
    }

    filteredPrompts.forEach(prompt => {
      const card = document.createElement('div');
      card.className = 'prompt-card';
      card.setAttribute('data-id', prompt.id);
      const tagsHtml = (Array.isArray(prompt.tags) ? prompt.tags : (prompt.tags||[])).map(tag => `<span class="tag">#${escapeHtml(tag)}</span>`).join('');
      card.innerHTML = `
        <div class="card-header">
          <div>
            <div class="card-title">${escapeHtml(prompt.title)}</div>
            <div class="category-badge">${escapeHtml((prompt.category||'').toUpperCase())}</div>
          </div>
          <div class="card-actions">
            <button class="icon-btn fav-btn ${prompt.favorite ? 'active' : ''}" data-fav="${prompt.id}" title="Toggle Favorite">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            </button>
            <button class="icon-btn" data-copy="${prompt.id}" title="Copy">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="icon-btn" data-edit="${prompt.id}" title="Edit">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
            </button>
            <button class="icon-btn" data-delete="${prompt.id}" title="Delete" style="color:var(--danger-color)">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </button>
          </div>
        </div>
        <div class="card-body">${escapeHtml(prompt.body)}</div>
        <div class="card-footer"><div class="tags">${tagsHtml}</div></div>
      `;
      const copyBtn = card.querySelector('[data-copy]');
      const editBtn = card.querySelector('[data-edit]');
      const deleteBtn = card.querySelector('[data-delete]');
      const favBtn = card.querySelector('[data-fav]');
      if (copyBtn) copyBtn.addEventListener('click', () => { navigator.clipboard.writeText(prompt.body).then(()=>showToast('Copied to clipboard!')); });
      if (editBtn) editBtn.addEventListener('click', () => openModal(prompt));
      if (deleteBtn) deleteBtn.addEventListener('click', () => deletePrompt(prompt.id));
      if (favBtn) favBtn.addEventListener('click', () => toggleFavorite(prompt.id));
      promptGrid.appendChild(card);
    });
  }

  function openModal(prompt = null) {
    const modalOverlay = document.getElementById('modalOverlay');
    if (!modalOverlay) return;
    modalOverlay.classList.remove('hidden');
    setTimeout(()=>modalOverlay.classList.add('visible'),10);
    const modalTitle = document.getElementById('modalTitle');
    const promptIdEl = document.getElementById('promptId');
    const titleEl = document.getElementById('title');
    const bodyEl = document.getElementById('body');
    const tagsEl = document.getElementById('tags');
    const categoryEl = document.getElementById('category');
    if (prompt) {
      if (modalTitle) modalTitle.textContent = 'Edit Prompt';
      if (promptIdEl) promptIdEl.value = prompt.id;
      if (titleEl) titleEl.value = prompt.title || '';
      if (bodyEl) bodyEl.value = prompt.body || '';
      if (tagsEl) tagsEl.value = Array.isArray(prompt.tags) ? prompt.tags.join(', ') : (prompt.tags || '');
      if (categoryEl) categoryEl.value = prompt.category || '';
      const modalDropdownSelected = document.querySelector('#modalCategoryDropdown .dropdown-selected');
      if (modalDropdownSelected) modalDropdownSelected.textContent = (prompt.category || '').charAt(0).toUpperCase() + (prompt.category || '').slice(1);
    } else {
      if (modalTitle) modalTitle.textContent = 'Add Prompt';
      if (promptIdEl) promptIdEl.value = '';
      if (titleEl) titleEl.value = '';
      if (bodyEl) bodyEl.value = '';
      if (tagsEl) tagsEl.value = '';
      if (categoryEl && categories.length) categoryEl.value = categories[0];
      const modalDropdownSelected = document.querySelector('#modalCategoryDropdown .dropdown-selected');
      if (modalDropdownSelected && categories.length) modalDropdownSelected.textContent = categories[0].charAt(0).toUpperCase() + categories[0].slice(1);
    }
  }

  function closeModal() {
    const modalOverlay = document.getElementById('modalOverlay');
    if (!modalOverlay) return;
    modalOverlay.classList.remove('visible');
    setTimeout(()=>modalOverlay.classList.add('hidden'),300);
  }

  async function handleFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('promptId').value;
    const title = document.getElementById('title').value;
    const category = document.getElementById('category').value || 'other';
    const body = document.getElementById('body').value;
    const tags = document.getElementById('tags').value.split(',').map(t=>t.trim()).filter(Boolean);
    const promptData = {
      id: id || Date.now().toString(),
      title: title || autoGenerateTitle(body),
      category,
      body,
      tags,
      date: new Date().toISOString(),
      favorite: id ? (prompts.find(p=>p.id===id)?.favorite || false) : false
    };
    if (id) {
      const index = prompts.findIndex(p=>p.id===id);
      if (index>-1) prompts[index] = {...prompts[index], ...promptData};
    } else {
      prompts.unshift(promptData);
    }
    saveToLocalStorage();
    renderPrompts();
    closeModal();
    showToast('Prompt saved!');
    // ensure cloud receives category field
    savePromptToSupabase(promptData);
  }

  function handleQuickAdd() {
    const quickPaste = document.getElementById('quickPaste');
    if (!quickPaste) return;
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
    savePromptToSupabase(newPrompt);
  }

  window.deletePrompt = async function (id) {
    if (!confirm("Delete this prompt?")) return;
    const prompt = prompts.find(p => p.id === id);
    if (!prompt) return;
    if (prompt.cloud_id && supabase) {
      try {
        const { error } = await supabase
          .from("prompt_saves")
          .delete()
          .eq("id", prompt.cloud_id);
        if (error) console.error("Cloud delete failed:", error);
      } catch (err) {
        console.error("Delete error:", err);
      }
    }
    prompts = prompts.filter(p => p.id !== id);
    saveToLocalStorage();
    renderPrompts();
    showToast("Deleted");
  };

  async function toggleFavorite(id) {
    const p = prompts.find(x=>x.id===id);
    if (!p) return;
    p.favorite = !p.favorite;
    saveToLocalStorage();
    renderPrompts();
    if (p.cloud_id && supabase) {
      try {
        const { error } = await supabase.from('prompt_saves').update({ favorite: p.favorite }).eq('id', p.cloud_id);
        if (error) { console.error('favorite update failed', error); queueOffline(p); }
      } catch (err) { console.error(err); queueOffline(p); }
    } else savePromptToSupabase(p);
  }

  // ---------- Export / Import ----------
  function exportData() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(prompts));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', `prompts_backup_${new Date().toISOString().slice(0,10)}.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function importDataFile(file) {
    if (!file) return;
    if (!confirm('This will merge imported prompts with your current ones. Continue?')) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const imported = JSON.parse(e.target.result);
        if (!Array.isArray(imported)) throw new Error('Invalid JSON');
        const currentIds = new Set(prompts.map(p=>p.id));
        let added = 0;
        for (const p of imported) {
          if (!currentIds.has(p.id)) {
            // ensure category exists
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

  // ---------- DOM wiring ----------
  document.addEventListener('DOMContentLoaded', () => {
    const fab = document.getElementById('fab');
    const modalOverlay = document.getElementById('modalOverlay');
    const closeBtn = document.getElementById('closeModal');
    const promptForm = document.getElementById('promptForm');
    const quickAddBtn = document.getElementById('quickAddBtn');
    const exportBtn = document.getElementById('exportBtn');
    const importBtn = document.getElementById('importBtn');
    const exportOption = document.getElementById('exportOption');
    const importOption = document.getElementById('importOption');
    const fileInput = document.getElementById('fileInput');
    const searchInput = document.getElementById('searchInput');
    const customCategoryDropdown = document.getElementById('customCategoryDropdown');
    const dropdownSelected = customCategoryDropdown ? customCategoryDropdown.querySelector('.dropdown-selected') : null;
    const dropdownOptions = customCategoryDropdown ? customCategoryDropdown.querySelector('.dropdown-options') : null;
    const modalCategoryDropdown = document.getElementById('modalCategoryDropdown');
    const modalDropdownOptions = modalCategoryDropdown ? modalCategoryDropdown.querySelector('.dropdown-options') : null;
    const modalDropdownSelected = modalCategoryDropdown ? modalCategoryDropdown.querySelector('.dropdown-selected') : null;
    const autoFillBtn = document.getElementById('autoFillBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsDropdown = document.getElementById('settingsDropdown');
    const themeOption = document.getElementById('themeOption');

    function renderCategoryOptions() {
      if (modalDropdownOptions) {
        modalDropdownOptions.innerHTML = '';
        categories.forEach(cat => {
          const d = document.createElement('div');
          d.className = 'dropdown-option';
          d.dataset.value = cat;
          d.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
          modalDropdownOptions.appendChild(d);
        });
        const addNew = document.createElement('div');
        addNew.className = 'dropdown-option';
        addNew.dataset.value = 'new-category';
        addNew.textContent = '+ Add New Category';
        modalDropdownOptions.appendChild(addNew);
      }
      if (dropdownOptions) {
        dropdownOptions.innerHTML = '';
        const allDiv = document.createElement('div');
        allDiv.className = 'dropdown-option';
        allDiv.dataset.value = 'all';
        allDiv.textContent = 'All Categories';
        dropdownOptions.appendChild(allDiv);
        categories.forEach(cat => {
          const d = document.createElement('div');
          d.className = 'dropdown-option';
          d.dataset.value = cat;
          d.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
          dropdownOptions.appendChild(d);
        });
      }
    }
    renderCategoryOptions();
    updateThemeUI();

    // hooks
    if (fab) fab.addEventListener('click', ()=>openModal());
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (promptForm) promptForm.addEventListener('submit', handleFormSubmit);
    if (quickAddBtn) quickAddBtn.addEventListener('click', handleQuickAdd);
    if (exportBtn) exportBtn.addEventListener('click', exportData);
    if (exportOption) exportOption.addEventListener('click', () => exportData());
    if (importBtn && fileInput) importBtn.addEventListener('click', ()=>fileInput.click());
    if (importOption && fileInput) importOption.addEventListener('click', () => fileInput.click());
    if (fileInput) fileInput.addEventListener('change', (e)=> importDataFile(e.target.files[0]));
    if (searchInput) searchInput.addEventListener('input', ()=> renderPrompts());

    if (dropdownSelected) dropdownSelected.addEventListener('click', (e)=> { e.stopPropagation(); customCategoryDropdown.classList.toggle('open'); });
    if (dropdownOptions) dropdownOptions.addEventListener('click', (e) => {
      const option = e.target.closest('.dropdown-option'); if (!option) return;
      const val = option.dataset.value; const text = option.textContent;
      if (dropdownSelected) { dropdownSelected.textContent = text; dropdownSelected.dataset.value = val; }
      customCategoryDropdown.classList.remove('open'); renderPrompts();
    });

    if (modalDropdownSelected) modalDropdownSelected.addEventListener('click', (e)=> { e.stopPropagation(); modalCategoryDropdown.classList.toggle('open'); });
    if (modalDropdownOptions) modalDropdownOptions.addEventListener('click', (e) => {
      const option = e.target.closest('.dropdown-option'); if (!option) return;
      const val = option.dataset.value;
      if (val === 'new-category') {
        const newCat = prompt('Enter new category name:'); if (!newCat) return;
        const formatted = newCat.trim().toLowerCase();
        if (!categories.includes(formatted)) { categories.push(formatted); saveCategories(); renderCategoryOptions(); }
        const catInput = document.getElementById('category'); if (catInput) catInput.value = formatted;
        if (modalDropdownSelected) modalDropdownSelected.textContent = formatted.charAt(0).toUpperCase()+formatted.slice(1);
      } else {
        const catInput = document.getElementById('category'); if (catInput) catInput.value = val;
        if (modalDropdownSelected) modalDropdownSelected.textContent = option.textContent;
      }
      if (modalCategoryDropdown) modalCategoryDropdown.classList.remove('open');
    });

    if (autoFillBtn) autoFillBtn.addEventListener('click', ()=> {
      const body = document.getElementById('body'); if (!body) return; const analysis = analyzePrompt(body.value || '');
      const titleEl = document.getElementById('title'); const tagsEl = document.getElementById('tags'); const catEl = document.getElementById('category');
      if (titleEl) titleEl.value = analysis.title; if (tagsEl) tagsEl.value = analysis.tags.join(', '); if (catEl) catEl.value = analysis.category;
      if (modalDropdownSelected) modalDropdownSelected.textContent = analysis.category.charAt(0).toUpperCase()+analysis.category.slice(1);
      showToast('Auto-filled metadata!');
    });
    if (themeOption) themeOption.addEventListener('click', () => { toggleTheme(); if (settingsDropdown) settingsDropdown.classList.remove('open'); });

    document.addEventListener('click', (e)=> {
      if (!customCategoryDropdown.contains(e.target)) customCategoryDropdown.classList.remove('open');
      if (settingsDropdown && !settingsDropdown.contains(e.target) && e.target !== settingsBtn) settingsDropdown.classList.remove('open');
      if (modalCategoryDropdown && !modalCategoryDropdown.contains(e.target)) modalCategoryDropdown.classList.remove('open');
    });
    if (settingsBtn) settingsBtn.addEventListener('click', (e)=> { e.stopPropagation(); if (settingsDropdown) settingsDropdown.classList.toggle('open'); });

    // FAB observer
    const footer = document.querySelector('footer');
    const aboutSection = document.querySelector('.about-section');
    if (fab && (footer || aboutSection)) {
      const observerOptions = { threshold: 0.1, rootMargin: '0px' };
      const fabObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) fab.classList.add('hide-fab'); else fab.classList.remove('hide-fab');
        });
      }, observerOptions);
      if (footer) fabObserver.observe(footer);
      if (aboutSection) fabObserver.observe(aboutSection);
    }

    // initial render
    renderPrompts();

    // Sync + realtime after DOM ready
    (async function startup() {
      await loadCategoriesFromCloud();
      await syncOfflineQueue();
      await loadPromptsFromSupabaseAndMerge();
      await testSupabaseConnection();
      renderPrompts();
      renderCategoryOptions();
      try {
        if (supabase) {
          supabase.channel('public:prompt_saves')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_saves' }, payload => {
              loadPromptsFromSupabaseAndMerge().then(()=>renderPrompts());
            })
            .subscribe();
        }
      } catch (e) {
        console.warn('Realtime subscribe failed', e);
      }
    })();
  }); // DOMContentLoaded end

})();
