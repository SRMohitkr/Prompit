document.addEventListener('DOMContentLoaded', () => {
    // State
    let prompts = JSON.parse(localStorage.getItem('prompts')) || [];
    let categories = JSON.parse(localStorage.getItem('categories')) || ['coding', 'writing', 'art', 'email', 'youtube', 'marketing', 'research', 'other'];

    // Theme Initialization
    // Theme Initialization
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    let currentTheme = savedTheme;
    // Onboarding: Add Welcome Prompt if empty
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
    // const categoryFilter = document.getElementById('categoryFilter'); // Removed
    const customCategoryDropdown = document.getElementById('customCategoryDropdown');
    const dropdownSelected = customCategoryDropdown.querySelector('.dropdown-selected');
    const dropdownOptions = customCategoryDropdown.querySelector('.dropdown-options');
    let currentCategory = 'all';

    // Modal Dropdown Elements
    const modalCategoryDropdown = document.getElementById('modalCategoryDropdown');
    const modalDropdownSelected = modalCategoryDropdown.querySelector('.dropdown-selected');
    const modalDropdownOptions = modalCategoryDropdown.querySelector('.dropdown-options');
    const categoryInput = document.getElementById('category');
    const quickPaste = document.getElementById('quickPaste');
    const quickAddBtn = document.getElementById('quickAddBtn');
    const toast = document.getElementById('toast');
    const exportBtn = document.getElementById('exportBtn'); // Removed
    const importBtn = document.getElementById('importBtn'); // Removed
    const fileInput = document.getElementById('fileInput');

    // Settings Menu Elements
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsDropdown = document.getElementById('settingsDropdown');
    const themeOption = document.getElementById('themeOption');
    const exportOption = document.getElementById('exportOption');
    const importOption = document.getElementById('importOption');

    // Update UI based on initial theme
    updateThemeUI();

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
        // Stop pulsing after 5 seconds or on click
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
    searchInput.addEventListener('input', renderPrompts);
    // categoryFilter.addEventListener('change', renderPrompts); // Removed

    // Custom Dropdown Event Listeners
    dropdownSelected.addEventListener('click', (e) => {
        e.stopPropagation();
        customCategoryDropdown.classList.toggle('open');
    });

    // Event Delegation for Custom Dropdown Options
    dropdownOptions.addEventListener('click', (e) => {
        const option = e.target.closest('.dropdown-option');
        if (!option) return;

        e.stopPropagation();
        const value = option.dataset.value;
        const text = option.textContent;

        currentCategory = value;
        dropdownSelected.textContent = text;
        customCategoryDropdown.classList.remove('open');

        // Update selected style
        const allOptions = dropdownOptions.querySelectorAll('.dropdown-option');
        allOptions.forEach(item => item.classList.remove('selected'));
        option.classList.add('selected');

        renderPrompts();
    });

    // Modal Dropdown Event Listeners
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

                // Update selected style
                const allOptions = modalDropdownOptions.querySelectorAll('.dropdown-option');
                allOptions.forEach(item => item.classList.remove('selected'));
                // Find the new option we just added/rendered
                const newOption = modalDropdownOptions.querySelector(`[data-value="${formattedCat}"]`);
                if (newOption) newOption.classList.add('selected');
            }
        } else {
            categoryInput.value = value;
            modalDropdownSelected.textContent = text;

            // Update selected style
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

    // Settings Menu Listeners
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

    // Close settings dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!settingsDropdown.contains(e.target)) {
            settingsDropdown.classList.remove('open');
        }
    });

    // exportBtn.addEventListener('click', exportData); // Removed
    // importBtn.addEventListener('click', () => fileInput.click()); // Removed
    // savePromptBtn.addEventListener('click', savePrompt); 
    autoFillBtn.addEventListener('click', handleAutoFill);
    // themeToggle.addEventListener('click', toggleTheme); // Removed

    // FAB / Footer Interaction
    const footer = document.querySelector('.app-footer');
    const aboutSection = document.querySelector('.about-section');

    if (fab) {
        const observer = new IntersectionObserver((entries) => {
            // Check if ANY of the observed elements are intersecting
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

    // Functions

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
        // 1. Update Modal Dropdown
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

        // Restore selection if valid, else default to first category
        if (categories.includes(currentVal)) {
            categoryInput.value = currentVal;
            modalDropdownSelected.textContent = currentVal.charAt(0).toUpperCase() + currentVal.slice(1);
        } else if (categories.length > 0 && !currentVal) {
            // Only default if empty (initial load)
            categoryInput.value = categories[0];
            modalDropdownSelected.textContent = categories[0].charAt(0).toUpperCase() + categories[0].slice(1);
        }

        // 2. Update Header Dropdown
        // Preserve current selection logic
        const dropdownOptionsContainer = document.querySelector('#customCategoryDropdown .dropdown-options');
        dropdownOptionsContainer.innerHTML = '';

        // Add 'All' option
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

        document.getElementById('title').value = analysis.title; // Changed modalTitle to document.getElementById('title')
        document.getElementById('tags').value = analysis.tags.join(', '); // Changed modalTags to document.getElementById('tags')

        // Update Category
        document.getElementById('category').value = analysis.category; // Changed modalCategory to document.getElementById('category')
        // Update custom dropdown UI
        const dropdown = document.getElementById('modalCategoryDropdown');
        const selectedDisplay = dropdown.querySelector('.dropdown-selected');
        selectedDisplay.textContent = analysis.category.charAt(0).toUpperCase() + analysis.category.slice(1);

        // Update options selection state
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
            const matchesSearch = p.title.toLowerCase().includes(searchTerm) ||
                p.body.toLowerCase().includes(searchTerm) ||
                p.tags.some(t => t.toLowerCase().includes(searchTerm));
            const matchesCategory = category === 'all' || p.category === category;
            return matchesSearch && matchesCategory;
        });

        // Sort by favorite then date (newest first)
        filteredPrompts.sort((a, b) => {
            if (a.favorite === b.favorite) {
                return new Date(b.date) - new Date(a.date);
            }
            return b.favorite - a.favorite;
        });

        if (filteredPrompts.length === 0) {
            promptGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #666; padding: 40px;">No prompts found. Add one to get started!</div>';
            return;
        }

        filteredPrompts.forEach(prompt => {
            const card = document.createElement('div');
            card.className = 'prompt-card';
            card.setAttribute('data-id', prompt.id);

            const tagsHtml = prompt.tags.map(tag => `<span class="tag">#${tag}</span>`).join('');

            card.innerHTML = `
                <div class="card-header">
                    <div class="card-title">${prompt.title}</div>
                    <div class="card-actions">
                        <button class="icon-btn fav-btn ${prompt.favorite ? 'active' : ''}" onclick="toggleFavorite('${prompt.id}')" title="Toggle Favorite">
                            ${icons.star}
                        </button>
                        <button class="icon-btn" onclick="copyPrompt('${prompt.id}')" title="Copy">
                            ${icons.copy}
                        </button>
                        <button class="icon-btn" onclick="editPrompt('${prompt.id}')" title="Edit">
                            ${icons.edit}
                        </button>
                        <button class="icon-btn" onclick="deletePrompt('${prompt.id}')" title="Delete" style="color: var(--danger-color)">
                            ${icons.trash}
                        </button>
                    </div>
                </div>
                <div class="category-badge">${prompt.category}</div>
                <div class="card-body">${escapeHtml(prompt.body)}</div>
                <div class="card-footer">
                    <div class="tags">${tagsHtml}</div>
                </div>
            `;
            promptGrid.appendChild(card);
        });
    }

    function openModal(prompt = null) {
        modalOverlay.classList.remove('hidden');
        // Small delay to allow display:flex to apply before opacity transition
        setTimeout(() => modalOverlay.classList.add('visible'), 10);

        if (prompt) {
            modalTitle.textContent = 'Edit Prompt';
            document.getElementById('promptId').value = prompt.id;
            document.getElementById('title').value = prompt.title;

            // Set Category
            categoryInput.value = prompt.category;
            modalDropdownSelected.textContent = prompt.category.charAt(0).toUpperCase() + prompt.category.slice(1);
            // Update selected class in dropdown
            const options = modalDropdownOptions.querySelectorAll('.dropdown-option');
            options.forEach(opt => {
                if (opt.dataset.value === prompt.category) opt.classList.add('selected');
                else opt.classList.remove('selected');
            });

            document.getElementById('body').value = prompt.body;
            document.getElementById('tags').value = prompt.tags.join(', ');
        } else {
            modalTitle.textContent = 'Add Prompt';
            promptForm.reset();
            document.getElementById('promptId').value = '';

            // Reset Category to default
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

    function handleFormSubmit(e) {
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
            favorite: id ? prompts.find(p => p.id === id).favorite : false
        };

        if (id) {
            const index = prompts.findIndex(p => p.id === id);
            prompts[index] = { ...prompts[index], ...promptData };
        } else {
            prompts.unshift(promptData);
        }

        saveToLocalStorage();
        renderPrompts();
        closeModalFunc();
        showToast('Prompt saved!');
    }

    // Smart Prompt Extraction Logic
    function analyzePrompt(text) {
        const lowerText = text.toLowerCase();
        let category = 'other';
        let tags = [];
        let isLikelyFavorite = false;

        // 1. Category Detection
        if (/(code|function|bug|js|python|java|html|css|react|node)/i.test(text)) category = 'coding';
        else if (/(email|cold email|outreach|newsletter|subject line)/i.test(text)) category = 'email';
        else if (/(youtube|video|thumbnail|hook|channel)/i.test(text) || (/(script)/i.test(text) && /(youtube|video)/i.test(text))) category = 'youtube';
        else if (/(ad|facebook|instagram|caption|marketing|seo|copy)/i.test(text)) category = 'marketing';
        else if (/(summarize|analysis|research|study|paper|data)/i.test(text)) category = 'research';
        else if (/(art|image|draw|paint|design|logo)/i.test(text)) category = 'art';
        else if (/(write|story|article|blog|script|essay|poem)/i.test(text)) category = 'writing';
        else category = 'other'; // Fallback to 'other' or 'general' if you prefer

        // 2. Tag Generation (Simple Keyword Extraction)
        const possibleTags = ['youtube', 'script', 'fitness', 'hindi', 'coding', 'python', 'js', 'email', 'marketing', 'blog', 'story', 'research', 'summary', 'bug', 'fix'];
        possibleTags.forEach(tag => {
            if (lowerText.includes(tag)) {
                tags.push(tag);
            }
        });
        // Ensure at least 2 tags if possible, or generic ones
        if (tags.length === 0) tags.push(category);
        if (tags.length < 2 && category !== 'other') tags.push('prompt');
        tags = tags.slice(0, 5); // Limit to 5

        // 3. Title Generation
        // Remove common starting phrases
        let cleanText = text.replace(/^(write a|create a|act as a|generate a|give me a)\s+/i, '');
        // Take first 4-7 words
        let words = cleanText.split(/\s+/);
        let title = words.slice(0, 6).join(' ');
        if (words.length > 6) title += '...';
        // Capitalize Title
        title = title.replace(/\b\w/g, l => l.toUpperCase());

        // 4. Auto Short Title
        let autoShortTitle = words.slice(0, 2).join(' ').replace(/\b\w/g, l => l.toUpperCase());

        // 5. Favorite Detection
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
    }

    function autoGenerateTitle(text) {
        const words = text.split(/\s+/);
        return words.slice(0, 4).join(' ') + (words.length > 4 ? '...' : '');
    }

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

    function importData(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!confirm('This will merge imported prompts with your current ones. Continue?')) {
            fileInput.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const importedPrompts = JSON.parse(e.target.result);
                if (Array.isArray(importedPrompts)) {
                    // Merge logic: avoid duplicates by ID
                    const currentIds = new Set(prompts.map(p => p.id));
                    let addedCount = 0;

                    importedPrompts.forEach(p => {
                        if (!currentIds.has(p.id)) {
                            prompts.push(p);
                            addedCount++;
                        }
                    });

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
    window.deletePrompt = function (id) {
        if (confirm('Are you sure you want to delete this prompt?')) {
            prompts = prompts.filter(p => p.id !== id);
            saveToLocalStorage();
            renderPrompts();
            showToast('Prompt deleted');
        }
    };

    window.editPrompt = function (id) {
        const prompt = prompts.find(p => p.id === id);
        if (prompt) openModal(prompt);
    };

    window.toggleFavorite = function (id) {
        const prompt = prompts.find(p => p.id === id);
        if (prompt) {
            prompt.favorite = !prompt.favorite;
            saveToLocalStorage();
            renderPrompts();
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
});
