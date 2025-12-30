import { ItemView, WorkspaceLeaf, Notice, debounce } from 'obsidian';
import { VIEW_TYPE_OMI_HUB, MEMORY_CATEGORY_EMOJI } from './constants';
import { TaskWithUI, SyncedConversationMeta, ConversationDetailData, ActionItem, CalendarEvent, TranscriptSegment, MemoryWithUI } from './types';
import { AddTaskModal, DatePickerModal, EditTaskModal, CalendarDatePickerModal, AddMemoryModal, EditMemoryModal } from './modals';
import type OmiConversationsPlugin from './main';

export class OmiHubView extends ItemView {
	plugin: OmiConversationsPlugin;

	// Hub state
	activeTab: 'tasks' | 'conversations' | 'memories' = 'tasks';

	// Tasks state
	tasks: TaskWithUI[] = [];
	searchQuery = '';
	// Section collapse states (flexible for new sections)
	sectionCollapsed: Record<string, boolean> = {
		today: false,
		tomorrow: false,
		noDeadline: false,
		later: false,
		completed: true  // Completed collapsed by default
	};
	private autoRefreshInterval: number | null = null;
	isLoading = false;

	// View mode state
	viewMode: 'list' | 'kanban' | 'calendar' = 'list';
	kanbanLayout: 'status' | 'date' = 'status';
	calendarViewType: 'monthly' | 'weekly' = 'monthly';
	calendarCurrentDate: Date = new Date();
	calendarShowCompleted = false;  // Hide completed tasks in calendar by default
	private draggedTask: TaskWithUI | null = null;

	// Conversations state
	isSyncingConversations = false;
	selectedConversationId: string | null = null;
	detailTab: 'summary' | 'transcript' = 'summary';
	selectedConversationData: ConversationDetailData | null = null;
	isLoadingDetail = false;
	statsTimeRange: 'week' | 'month' | '30days' | 'all' = 'all';
	dailyViewSelectedDate: string | null = null; // YYYY-MM-DD format for unified daily view

	// Memories state
	memories: MemoryWithUI[] = [];
	memoriesSearchQuery = '';
	memoriesCategoryFilter: string | null = null;
	memoriesViewMode: 'list' | 'graph' = 'list';
	selectedTagForDetails: string | null = null;  // Currently selected tag to show memories
	isLoadingMemories = false;
	private memoriesAutoRefreshInterval: number | null = null;
	private graphAnimationId: number | null = null;

	// Debounced backup sync
	private requestBackupSync: () => void;

	// Search focus state (to restore after render)
	private activeSearchId: string | null = null;
	private searchCursorPosition: number = 0;

	// Debounced search render
	private debouncedSearchRender: () => void;

	constructor(leaf: WorkspaceLeaf, plugin: OmiConversationsPlugin) {
		super(leaf);
		this.plugin = plugin;

		// Debounce search render to avoid losing focus on every keystroke
		this.debouncedSearchRender = debounce(() => {
			this.render();
			// Restore focus after render
			if (this.activeSearchId) {
				const input = this.containerEl.querySelector(`#${this.activeSearchId}`) as HTMLInputElement;
				if (input) {
					input.focus();
					input.setSelectionRange(this.searchCursorPosition, this.searchCursorPosition);
				}
			}
		}, 150, true);

		// Debounce sync requests to avoid API spam (wait 2 seconds after last change)
		this.requestBackupSync = debounce(async () => {
			if (this.plugin.settings.enableTasksHub) {
				// We don't need to show a notice for background syncs
				await this.plugin.tasksHubSync.pullFromAPI();
			}
		}, 2000, true);
	}

	getViewType(): string {
		return VIEW_TYPE_OMI_HUB;
	}

	getDisplayText(): string {
		return 'Omi Hub';
	}

	getIcon(): string {
		return 'brain';
	}

	async onOpen(): Promise<void> {
		// Load saved hub and view preferences
		this.activeTab = this.plugin.settings.activeHubTab || 'tasks';
		this.viewMode = this.plugin.settings.tasksViewMode || 'list';
		this.kanbanLayout = this.plugin.settings.tasksKanbanLayout || 'status';
		this.calendarViewType = this.plugin.settings.tasksCalendarType || 'monthly';
		this.memoriesCategoryFilter = this.plugin.settings.memoriesCategoryFilter || null;
		this.memoriesViewMode = this.plugin.settings.memoriesViewMode || 'list';

		// Load data based on active tab
		if (this.activeTab === 'tasks') {
			await this.loadTasks();
		} else if (this.activeTab === 'memories') {
			await this.loadMemories();
		}
		this.render();
		this.startAutoRefresh();

		// Register keyboard shortcuts
		this.containerEl.addEventListener('keydown', this.handleKeyDown.bind(this));
	}

	async onClose(): Promise<void> {
		this.stopAutoRefresh();
		this.stopMemoriesAutoRefresh();
		this.stopGraphAnimation();
	}

	private handleKeyDown(e: KeyboardEvent): void {
		// Cmd/Ctrl + N: Add new task
		if (e.key === 'n' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			this.showAddTaskDialog();
		}
		// Cmd/Ctrl + R: Refresh/sync tasks
		if (e.key === 'r' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			this.loadTasks().then(() => {
				this.render();
				new Notice('Tasks synced');
			});
		}
		// Escape: Clear search
		if (e.key === 'Escape' && this.searchQuery) {
			e.preventDefault();
			this.searchQuery = '';
			this.render();
		}
	}

	private startAutoRefresh(): void {
		this.stopAutoRefresh();  // Clear any existing interval

		const intervalMinutes = this.plugin.settings.tasksViewAutoRefresh;
		if (intervalMinutes > 0) {
			const intervalMs = intervalMinutes * 60 * 1000;
			this.autoRefreshInterval = window.setInterval(async () => {
				await this.loadTasks();
				this.render();
			}, intervalMs);
		}
	}

	private stopAutoRefresh(): void {
		if (this.autoRefreshInterval !== null) {
			window.clearInterval(this.autoRefreshInterval);
			this.autoRefreshInterval = null;
		}
	}

	private startMemoriesAutoRefresh(): void {
		this.stopMemoriesAutoRefresh();
		const intervalMinutes = this.plugin.settings.memoriesViewAutoRefresh;
		if (intervalMinutes > 0) {
			const intervalMs = intervalMinutes * 60 * 1000;
			this.memoriesAutoRefreshInterval = window.setInterval(async () => {
				await this.loadMemories();
				this.render();
			}, intervalMs);
		}
	}

	private stopMemoriesAutoRefresh(): void {
		if (this.memoriesAutoRefreshInterval !== null) {
			window.clearInterval(this.memoriesAutoRefreshInterval);
			this.memoriesAutoRefreshInterval = null;
		}
	}

	private stopGraphAnimation(): void {
		if (this.graphAnimationId !== null) {
			cancelAnimationFrame(this.graphAnimationId);
			this.graphAnimationId = null;
		}
	}

	async loadMemories(showNotice = false): Promise<void> {
		this.isLoadingMemories = true;
		this.render();
		try {
			const items = await this.plugin.api.getAllMemories();
			this.memories = items.map(item => ({
				...item,
				isEditing: false
			}));
			if (showNotice) {
				new Notice(`Loaded ${this.memories.length} memories from Omi`);
			}
		} catch (error) {
			console.error('Error loading memories from API:', error);
			new Notice('Failed to load memories from Omi');
			this.memories = [];
		} finally {
			this.isLoadingMemories = false;
		}
	}

	async loadTasks(showNotice = false): Promise<void> {
		this.isLoading = true;
		this.render();  // Show loading skeleton
		try {
			const items = await this.plugin.api.getAllActionItems();
			this.tasks = items.map(item => ({
				id: item.id,
				description: item.description,
				completed: item.completed,
				dueAt: item.due_at ? this.parseDueAt(item.due_at) : null,
				sourceLink: item.conversation_id ? `conversation:${item.conversation_id}` : null,
				lineIndex: -1,  // Not used in API-first mode
				isEditing: false
			}));
			if (showNotice) {
				new Notice(`Synced ${this.tasks.length} tasks from Omi`);
			}
		} catch (error) {
			console.error('Error loading tasks from API:', error);
			new Notice('Failed to load tasks from Omi');
			this.tasks = [];
		} finally {
			this.isLoading = false;
		}
	}

	// Parse due_at from API (ISO format) to local format for storage
	private parseDueAt(isoString: string): string {
		// API returns full ISO: "2025-12-29T14:30:00Z" or just date: "2025-12-29"
		if (isoString.includes('T')) {
			// Has time component - preserve date and time (HH:MM)
			const date = new Date(isoString);
			const year = date.getFullYear();
			const month = String(date.getMonth() + 1).padStart(2, '0');
			const day = String(date.getDate()).padStart(2, '0');
			const hours = String(date.getHours()).padStart(2, '0');
			const minutes = String(date.getMinutes()).padStart(2, '0');
			// Only include time if it's not midnight (00:00)
			if (hours === '00' && minutes === '00') {
				return `${year}-${month}-${day}`;
			}
			return `${year}-${month}-${day}T${hours}:${minutes}`;
		}
		return isoString;  // Just date
	}

	// Format due date/time for display
	private formatDueDateTime(dueAt: string): string {
		if (dueAt.includes('T')) {
			const [date, time] = dueAt.split('T');
			// Format time nicely (e.g., "2:30 PM")
			const [hours, minutes] = time.split(':').map(Number);
			const ampm = hours >= 12 ? 'PM' : 'AM';
			const hour12 = hours % 12 || 12;
			return `${date} ${hour12}:${minutes.toString().padStart(2, '0')} ${ampm}`;
		}
		return dueAt;  // Just date
	}

	// Convert local datetime string to UTC ISO format for API
	// Input: "2025-12-29" or "2025-12-29T11:00" (local time)
	// Output: "2025-12-29" or "2025-12-29T19:00:00.000Z" (UTC ISO)
	private localToUTC(localDateTime: string | null): string | null {
		if (!localDateTime) return null;

		if (localDateTime.includes('T')) {
			// Has time component - convert local to UTC
			// Parse as local time by creating Date from the local datetime string
			const date = new Date(localDateTime);
			return date.toISOString();
		}
		// Date only - return as-is (API handles date-only strings correctly)
		return localDateTime;
	}

	render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('omi-hub-container');

		// Hub Header
		this.renderHubHeader(container);

		// Hub Tab Navigation
		this.renderHubTabs(container);

		// Tab Content
		if (this.activeTab === 'tasks') {
			this.renderTasksTab(container);
		} else if (this.activeTab === 'conversations') {
			this.renderConversationsTab(container);
		} else if (this.activeTab === 'memories') {
			this.renderMemoriesTab(container);
		}
	}

	private renderHubHeader(container: HTMLElement): void {
		const header = container.createDiv('omi-hub-header');
		header.createEl('h2', { text: 'Omi Hub' });
	}

	private renderHubTabs(container: HTMLElement): void {
		const tabs = container.createDiv('omi-hub-tabs');
		tabs.setAttribute('role', 'tablist');

		const tasksTab = tabs.createEl('button', {
			text: 'Tasks',
			cls: `omi-hub-tab ${this.activeTab === 'tasks' ? 'active' : ''}`
		});
		tasksTab.setAttribute('role', 'tab');
		tasksTab.setAttribute('aria-selected', String(this.activeTab === 'tasks'));
		if (this.tasks.length > 0) {
			const pendingCount = this.tasks.filter(t => !t.completed).length;
			if (pendingCount > 0) {
				tasksTab.createEl('span', { text: String(pendingCount), cls: 'omi-hub-tab-badge' });
			}
		}
		tasksTab.addEventListener('click', async () => {
			this.activeTab = 'tasks';
			this.plugin.settings.activeHubTab = 'tasks';
			await this.plugin.saveSettings();
			if (this.tasks.length === 0) {
				await this.loadTasks();
			}
			this.render();
		});

		const conversationsTab = tabs.createEl('button', {
			text: 'Conversations',
			cls: `omi-hub-tab ${this.activeTab === 'conversations' ? 'active' : ''}`
		});
		conversationsTab.setAttribute('role', 'tab');
		conversationsTab.setAttribute('aria-selected', String(this.activeTab === 'conversations'));
		const syncedCount = Object.keys(this.plugin.settings.syncedConversations || {}).length;
		if (syncedCount > 0) {
			conversationsTab.createEl('span', { text: String(syncedCount), cls: 'omi-hub-tab-badge' });
		}
		conversationsTab.addEventListener('click', async () => {
			this.activeTab = 'conversations';
			this.plugin.settings.activeHubTab = 'conversations';
			await this.plugin.saveSettings();
			this.render();
		});

		const memoriesTab = tabs.createEl('button', {
			text: 'Memories',
			cls: `omi-hub-tab ${this.activeTab === 'memories' ? 'active' : ''}`
		});
		memoriesTab.setAttribute('role', 'tab');
		memoriesTab.setAttribute('aria-selected', String(this.activeTab === 'memories'));
		if (this.memories.length > 0) {
			memoriesTab.createEl('span', { text: String(this.memories.length), cls: 'omi-hub-tab-badge' });
		}
		memoriesTab.addEventListener('click', async () => {
			this.activeTab = 'memories';
			this.plugin.settings.activeHubTab = 'memories';
			await this.plugin.saveSettings();
			if (this.memories.length === 0) {
				await this.loadMemories();
			}
			this.startMemoriesAutoRefresh();
			this.render();
		});
	}

	private renderTasksTab(container: HTMLElement): void {
		const tabContent = container.createDiv('omi-tasks-container');

		// View Mode Tabs
		this.renderViewModeTabs(tabContent);

		// Toolbar: Add Task + Search + Sync button
		const toolbar = tabContent.createDiv('omi-tasks-toolbar');
		toolbar.setAttribute('role', 'toolbar');

		const addBtn = toolbar.createEl('button', { text: '+ Add Task', cls: 'omi-tasks-add-btn' });
		addBtn.setAttribute('aria-label', 'Add new task');
		addBtn.addEventListener('click', () => this.showAddTaskDialog());

		const searchInput = toolbar.createEl('input', {
			type: 'text',
			placeholder: 'Search tasks...',
			cls: 'omi-tasks-search'
		});
		searchInput.id = 'omi-tasks-search';
		searchInput.value = this.searchQuery;
		searchInput.setAttribute('aria-label', 'Search tasks');
		searchInput.addEventListener('input', (e) => {
			const input = e.target as HTMLInputElement;
			this.searchQuery = input.value;
			this.activeSearchId = 'omi-tasks-search';
			this.searchCursorPosition = input.selectionStart || 0;
			this.debouncedSearchRender();
		});

		const syncBtn = toolbar.createEl('button', { text: 'Sync', cls: 'omi-tasks-sync-btn' });
		syncBtn.setAttribute('aria-label', 'Sync tasks from Omi');
		syncBtn.addEventListener('click', async () => {
			await this.loadTasks(true);  // Show notice with count
			this.render();
		});

		// Show loading skeleton if loading
		if (this.isLoading) {
			this.renderLoadingSkeleton(tabContent);
			return;
		}

		// Show empty state if no tasks
		if (this.tasks.length === 0) {
			this.renderEmptyState(tabContent, 'all');
			return;
		}

		// Render the appropriate view based on viewMode
		switch (this.viewMode) {
			case 'list':
				this.renderListView(tabContent);
				break;
			case 'kanban':
				this.renderKanbanView(tabContent);
				break;
			case 'calendar':
				this.renderCalendarView(tabContent);
				break;
		}
	}

	private renderMemoriesTab(container: HTMLElement): void {
		// Stop any running graph animation when switching views
		this.stopGraphAnimation();

		const tabContent = container.createDiv('omi-memories-container');

		// View Mode Tabs
		this.renderMemoriesViewModeTabs(tabContent);

		// Toolbar: Add button + Sync button
		const toolbar = tabContent.createDiv('omi-memories-toolbar');

		// Only show Add Memory button in list view
		if (this.memoriesViewMode === 'list') {
			const addBtn = toolbar.createEl('button', { text: '+ Add Memory', cls: 'omi-memories-add-btn' });
			addBtn.setAttribute('aria-label', 'Add new memory');
			addBtn.addEventListener('click', () => this.showAddMemoryDialog());
		}

		const syncBtn = toolbar.createEl('button', { text: '🔄 Refresh', cls: 'omi-memories-sync-btn' });
		syncBtn.setAttribute('aria-label', 'Refresh memories from Omi');
		syncBtn.addEventListener('click', async () => {
			await this.loadMemories(true);
			this.render();
		});

		// Show loading skeleton
		if (this.isLoadingMemories) {
			const skeleton = tabContent.createDiv('omi-memories-loading');
			skeleton.createEl('div', { cls: 'omi-loading-skeleton' });
			skeleton.createEl('div', { cls: 'omi-loading-skeleton' });
			skeleton.createEl('div', { cls: 'omi-loading-skeleton' });
			return;
		}

		// Render based on view mode
		switch (this.memoriesViewMode) {
			case 'graph':
				this.renderTagGraph(tabContent);
				break;
			default:
				this.renderMemoriesListView(tabContent);
		}
	}

	private renderMemoriesViewModeTabs(container: HTMLElement): void {
		const tabs = container.createDiv('omi-memories-view-tabs');
		tabs.setAttribute('role', 'tablist');
		tabs.setAttribute('aria-label', 'Memory view modes');

		const modes: Array<{ id: 'list' | 'graph'; label: string; icon: string }> = [
			{ id: 'list', label: 'List', icon: '📋' },
			{ id: 'graph', label: 'Tags', icon: '🕸️' }
		];

		for (const mode of modes) {
			const tab = tabs.createEl('button', {
				text: `${mode.icon} ${mode.label}`,
				cls: `omi-memories-view-tab ${this.memoriesViewMode === mode.id ? 'active' : ''}`
			});
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', String(this.memoriesViewMode === mode.id));
			tab.setAttribute('aria-label', `${mode.label} view`);
			tab.addEventListener('click', async () => {
				this.memoriesViewMode = mode.id;
				this.plugin.settings.memoriesViewMode = mode.id;
				await this.plugin.saveSettings();
				this.render();
			});
		}
	}

	private renderMemoriesListView(container: HTMLElement): void {
		// Category filter pills
		const categoryPills = container.createDiv('omi-category-pills');

		// Get category counts
		const categoryCounts: Record<string, number> = {};
		for (const memory of this.memories) {
			const cat = memory.category || 'other';
			categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
		}

		// "All" pill
		const allPill = categoryPills.createEl('button', {
			text: `All (${this.memories.length})`,
			cls: `omi-category-pill ${this.memoriesCategoryFilter === null ? 'active' : ''}`
		});
		allPill.addEventListener('click', async () => {
			this.memoriesCategoryFilter = null;
			this.plugin.settings.memoriesCategoryFilter = null;
			await this.plugin.saveSettings();
			this.render();
		});

		// Category pills with counts
		const sortedCategories = Object.entries(categoryCounts)
			.sort((a, b) => b[1] - a[1]);  // Sort by count descending

		for (const [cat, count] of sortedCategories) {
			const emoji = MEMORY_CATEGORY_EMOJI[cat] || '📌';
			const pill = categoryPills.createEl('button', {
				text: `${emoji} ${cat} (${count})`,
				cls: `omi-category-pill ${this.memoriesCategoryFilter === cat ? 'active' : ''}`
			});
			pill.addEventListener('click', async () => {
				// Toggle: if already selected, clear filter; otherwise select
				if (this.memoriesCategoryFilter === cat) {
					this.memoriesCategoryFilter = null;
					this.plugin.settings.memoriesCategoryFilter = null;
				} else {
					this.memoriesCategoryFilter = cat;
					this.plugin.settings.memoriesCategoryFilter = cat;
				}
				await this.plugin.saveSettings();
				this.render();
			});
		}

		// Search input
		const searchContainer = container.createDiv('omi-memories-search-container');
		const searchInput = searchContainer.createEl('input', {
			type: 'text',
			placeholder: '🔍 Search memories...',
			cls: 'omi-memories-search'
		});
		searchInput.id = 'omi-memories-search';
		searchInput.value = this.memoriesSearchQuery;
		searchInput.addEventListener('input', (e) => {
			const input = e.target as HTMLInputElement;
			this.memoriesSearchQuery = input.value;
			this.activeSearchId = 'omi-memories-search';
			this.searchCursorPosition = input.selectionStart || 0;
			this.debouncedSearchRender();
		});

		// Filter memories
		let filteredMemories = this.memories;
		if (this.memoriesCategoryFilter) {
			filteredMemories = filteredMemories.filter(m => m.category === this.memoriesCategoryFilter);
		}
		if (this.memoriesSearchQuery) {
			const query = this.memoriesSearchQuery.toLowerCase();
			filteredMemories = filteredMemories.filter(m =>
				m.content.toLowerCase().includes(query) ||
				m.tags.some(t => t.toLowerCase().includes(query))
			);
		}

		// Memory list
		const memoryList = container.createDiv('omi-memories-list');

		if (filteredMemories.length === 0) {
			const empty = memoryList.createDiv('omi-memories-empty');
			if (this.memories.length === 0) {
				empty.setText('No memories yet. Click "Refresh" to load from Omi.');
			} else {
				empty.setText('No memories match your filters.');
			}
			return;
		}

		// Render memory cards
		for (const memory of filteredMemories) {
			this.renderMemoryCard(memoryList, memory);
		}
	}

	private renderMemoryCard(container: HTMLElement, memory: MemoryWithUI): void {
		const card = container.createDiv('omi-memory-card');

		// Header: category + date
		const header = card.createDiv('omi-memory-card-header');
		const emoji = MEMORY_CATEGORY_EMOJI[memory.category] || '📌';
		header.createEl('span', { text: `${emoji} ${memory.category}`, cls: 'omi-memory-category' });

		const date = new Date(memory.created_at);
		const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
		header.createEl('span', { text: dateStr, cls: 'omi-memory-date' });

		// Content (inline editable)
		const contentDiv = card.createDiv('omi-memory-content');
		if (memory.isEditing) {
			const textarea = contentDiv.createEl('textarea', { cls: 'omi-memory-content-edit' });
			textarea.value = memory.content;
			textarea.rows = 3;
			textarea.focus();
			textarea.addEventListener('blur', async () => {
				const newContent = textarea.value.trim();
				if (newContent && newContent !== memory.content && newContent.length <= 500) {
					await this.updateMemoryContent(memory, newContent);
				}
				memory.isEditing = false;
				this.render();
			});
			textarea.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					textarea.blur();
				}
				if (e.key === 'Escape') {
					memory.isEditing = false;
					this.render();
				}
			});
		} else {
			contentDiv.setText(memory.content);
			contentDiv.addClass('omi-memory-content-text');
			contentDiv.addEventListener('click', () => {
				memory.isEditing = true;
				this.render();
			});
		}

		// Footer: Tags + Actions on same row
		const footer = card.createDiv('omi-memory-footer');

		// Tags
		const tagsDiv = footer.createDiv('omi-memory-tags');
		if (memory.tags && memory.tags.length > 0) {
			for (const tag of memory.tags) {
				tagsDiv.createEl('span', { text: tag, cls: 'omi-tag-pill' });
			}
		}

		// Actions
		const actions = footer.createDiv('omi-memory-actions');
		const editBtn = actions.createEl('button', { text: '✏️', cls: 'omi-memory-action-btn' });
		editBtn.setAttribute('aria-label', 'Edit memory');
		editBtn.addEventListener('click', () => this.showEditMemoryDialog(memory));

		const deleteBtn = actions.createEl('button', { text: '🗑️', cls: 'omi-memory-action-btn' });
		deleteBtn.setAttribute('aria-label', 'Delete memory');
		deleteBtn.addEventListener('click', () => this.deleteMemory(memory));
	}

	private showAddMemoryDialog(): void {
		// Collect unique tags from all memories for autocomplete
		const availableTags = this.getAvailableTags();
		new AddMemoryModal(this.app, availableTags, async (content, category, tags) => {
			await this.addNewMemory(content, category, tags);
		}).open();
	}

	private getAvailableTags(): string[] {
		const tagSet = new Set<string>();
		for (const memory of this.memories) {
			if (memory.tags) {
				for (const tag of memory.tags) {
					tagSet.add(tag.toLowerCase());
				}
			}
		}
		return Array.from(tagSet).sort();
	}

	private showEditMemoryDialog(memory: MemoryWithUI): void {
		new EditMemoryModal(
			this.app,
			memory,
			async (updates) => {
				await this.updateMemory(memory, updates);
			},
			async () => {
				await this.deleteMemory(memory);
			}
		).open();
	}

	private async addNewMemory(content: string, category: string, tags?: string[]): Promise<void> {
		try {
			const newMemory = await this.plugin.api.createMemory(content, category, undefined, tags);
			this.memories.unshift({
				...newMemory,
				isEditing: false
			});
			this.render();
			new Notice('Memory added');
		} catch (error) {
			console.error('Error creating memory:', error);
			new Notice('Failed to add memory');
		}
	}

	private async updateMemoryContent(memory: MemoryWithUI, newContent: string): Promise<void> {
		try {
			await this.plugin.api.updateMemory(memory.id, { content: newContent });
			memory.content = newContent;
			new Notice('Memory updated');
		} catch (error) {
			console.error('Error updating memory:', error);
			new Notice('Failed to update memory');
		}
	}

	private async updateMemory(memory: MemoryWithUI, updates: { content?: string; category?: string; visibility?: 'public' | 'private' }): Promise<void> {
		try {
			const updatedMemory = await this.plugin.api.updateMemory(memory.id, updates);
			// Update local state
			Object.assign(memory, updatedMemory);
			this.render();
			new Notice('Memory updated');
		} catch (error) {
			console.error('Error updating memory:', error);
			new Notice('Failed to update memory');
		}
	}

	private async deleteMemory(memory: MemoryWithUI): Promise<void> {
		if (!confirm('Delete this memory? This action cannot be undone.')) {
			return;
		}
		try {
			await this.plugin.api.deleteMemory(memory.id);
			this.memories = this.memories.filter(m => m.id !== memory.id);
			this.render();
			new Notice('Memory deleted');
		} catch (error) {
			console.error('Error deleting memory:', error);
			new Notice('Failed to delete memory');
		}
	}

	// ==================== TAG GRAPH VISUALIZATION ====================

	private renderTagGraph(container: HTMLElement): void {
		// Create wrapper for graph + details panel
		const wrapper = container.createDiv('omi-graph-wrapper');
		const graphContainer = wrapper.createDiv('omi-graph-container');

		// Build tag co-occurrence data
		const { nodes, edges } = this.buildTagCooccurrenceGraph();

		if (nodes.length === 0) {
			const empty = graphContainer.createDiv('omi-graph-empty');
			empty.setText('No tags found. Memories need tags to visualize relationships.');
			return;
		}

		// Details panel (initially hidden)
		const detailsPanel = wrapper.createDiv('omi-tag-details-panel');
		detailsPanel.style.display = 'none';

		// Create canvas
		const canvas = graphContainer.createEl('canvas', { cls: 'omi-graph-canvas' });
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		// Set canvas size
		const resizeCanvas = () => {
			const rect = graphContainer.getBoundingClientRect();
			canvas.width = rect.width;
			canvas.height = Math.max(400, rect.height);
		};
		resizeCanvas();

		// Initialize node positions in a tight circular cluster at center
		const initialRadius = Math.min(canvas.width, canvas.height) * 0.2;
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			// Distribute in a spiral pattern for better initial spacing
			const angle = (i / nodes.length) * Math.PI * 6; // Multiple rotations
			const r = (i / nodes.length) * initialRadius;
			node.x = canvas.width / 2 + Math.cos(angle) * r + (Math.random() - 0.5) * 20;
			node.y = canvas.height / 2 + Math.sin(angle) * r + (Math.random() - 0.5) * 20;
			node.vx = 0;
			node.vy = 0;
		}

		// Tooltip element
		const tooltip = graphContainer.createDiv('omi-graph-tooltip');
		tooltip.style.display = 'none';

		// Legend
		const legend = graphContainer.createDiv('omi-graph-legend');
		legend.createEl('div', { text: 'Tag Graph', cls: 'omi-graph-legend-title' });
		legend.createEl('div', { text: `${nodes.length} tags`, cls: 'omi-graph-legend-stat' });
		legend.createEl('div', { text: `${edges.length} connections`, cls: 'omi-graph-legend-stat' });
		legend.createEl('div', { text: 'Scroll to zoom • Drag to pan', cls: 'omi-graph-legend-hint' });
		legend.createEl('div', { text: 'Drag tags to rearrange', cls: 'omi-graph-legend-hint' });

		// Track interaction state
		let hoveredNode: typeof nodes[0] | null = null;
		let selectedNode: typeof nodes[0] | null = null;

		// Transform state for zoom and pan
		let scale = 1;
		let offsetX = 0;
		let offsetY = 0;
		const minScale = 0.3;
		const maxScale = 3;

		// Drag state
		let isDragging = false;
		let draggedNode: typeof nodes[0] | null = null;
		let isPanning = false;
		let lastMouseX = 0;
		let lastMouseY = 0;

		// Convert screen coordinates to graph coordinates
		const screenToGraph = (screenX: number, screenY: number) => {
			return {
				x: (screenX - offsetX) / scale,
				y: (screenY - offsetY) / scale
			};
		};

		// Find node at position (in screen coordinates)
		const findNodeAtPosition = (screenX: number, screenY: number) => {
			const graphPos = screenToGraph(screenX, screenY);
			for (const node of nodes) {
				const dx = graphPos.x - node.x;
				const dy = graphPos.y - node.y;
				const radius = Math.max(8, Math.min(25, node.count * 2));
				// Slightly larger hit area for easier selection
				if (dx * dx + dy * dy < (radius + 5) * (radius + 5)) {
					return node;
				}
			}
			return null;
		};

		// Function to show tag details
		const showTagDetails = (tag: string) => {
			detailsPanel.empty();
			detailsPanel.style.display = 'block';

			// Header with close button
			const header = detailsPanel.createDiv('omi-tag-details-header');
			header.createEl('span', { text: `#${tag}`, cls: 'omi-tag-details-title' });
			const closeBtn = header.createEl('button', { text: '×', cls: 'omi-tag-details-close' });
			closeBtn.addEventListener('click', () => {
				detailsPanel.style.display = 'none';
				selectedNode = null;
			});

			// Find memories with this tag
			const memoriesWithTag = this.memories.filter(m =>
				m.tags && m.tags.some(t => t.toLowerCase() === tag.toLowerCase())
			);

			const countDiv = detailsPanel.createDiv('omi-tag-details-count');
			countDiv.setText(`${memoriesWithTag.length} ${memoriesWithTag.length === 1 ? 'memory' : 'memories'}`);

			// Memory list
			const memoryList = detailsPanel.createDiv('omi-tag-details-list');
			for (const memory of memoriesWithTag) {
				const item = memoryList.createDiv('omi-tag-memory-item');
				const emoji = MEMORY_CATEGORY_EMOJI[memory.category] || '📌';
				item.createEl('span', { text: emoji, cls: 'omi-tag-memory-emoji' });
				item.createEl('span', { text: memory.content, cls: 'omi-tag-memory-content' });

				// Click to edit
				item.addEventListener('click', () => {
					this.showEditMemoryDialog(memory);
				});
			}
		};

		// Zoom handler
		canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			const rect = canvas.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			// Zoom factor
			const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
			const newScale = Math.max(minScale, Math.min(maxScale, scale * zoomFactor));

			if (newScale !== scale) {
				// Zoom toward mouse position
				const graphPos = screenToGraph(mouseX, mouseY);
				scale = newScale;
				offsetX = mouseX - graphPos.x * scale;
				offsetY = mouseY - graphPos.y * scale;
			}
		}, { passive: false });

		// Mouse down - start drag or pan
		canvas.addEventListener('mousedown', (e) => {
			const rect = canvas.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			const node = findNodeAtPosition(mouseX, mouseY);
			if (node) {
				// Start dragging node
				isDragging = true;
				draggedNode = node;
				canvas.style.cursor = 'grabbing';
			} else {
				// Start panning
				isPanning = true;
				canvas.style.cursor = 'grabbing';
			}
			lastMouseX = mouseX;
			lastMouseY = mouseY;
		});

		// Mouse move - drag node, pan, or hover
		canvas.addEventListener('mousemove', (e) => {
			const rect = canvas.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			if (isDragging && draggedNode) {
				// Move the dragged node
				const graphPos = screenToGraph(mouseX, mouseY);
				draggedNode.x = graphPos.x;
				draggedNode.y = graphPos.y;
				// Stop any velocity when manually dragging
				draggedNode.vx = 0;
				draggedNode.vy = 0;
			} else if (isPanning) {
				// Pan the view
				const dx = mouseX - lastMouseX;
				const dy = mouseY - lastMouseY;
				offsetX += dx;
				offsetY += dy;
				lastMouseX = mouseX;
				lastMouseY = mouseY;
			} else {
				// Hover detection
				hoveredNode = findNodeAtPosition(mouseX, mouseY);

				if (hoveredNode) {
					tooltip.style.display = 'block';
					tooltip.style.left = `${mouseX + 10}px`;
					tooltip.style.top = `${mouseY - 30}px`;
					tooltip.setText(`${hoveredNode.label} (${hoveredNode.count} memories) - click to view`);
					canvas.style.cursor = 'pointer';
				} else {
					tooltip.style.display = 'none';
					canvas.style.cursor = 'grab';
				}
			}
		});

		// Mouse up - end drag or pan, and handle click
		canvas.addEventListener('mouseup', (e) => {
			const rect = canvas.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			// Check if this was a click (minimal movement)
			const dx = mouseX - lastMouseX;
			const dy = mouseY - lastMouseY;
			const wasClick = !isDragging && !isPanning || (dx * dx + dy * dy < 25);

			if (wasClick && !isPanning) {
				// Handle click on node
				const node = findNodeAtPosition(mouseX, mouseY);
				if (node) {
					selectedNode = node;
					showTagDetails(node.label);
				}
			}

			isDragging = false;
			draggedNode = null;
			isPanning = false;
			canvas.style.cursor = hoveredNode ? 'pointer' : 'grab';
		});

		canvas.addEventListener('mouseleave', () => {
			tooltip.style.display = 'none';
			hoveredNode = null;
			isDragging = false;
			draggedNode = null;
			isPanning = false;
		});

		// Double-click to reset zoom
		canvas.addEventListener('dblclick', () => {
			scale = 1;
			offsetX = 0;
			offsetY = 0;
		});

		// Force simulation parameters
		const centerX = canvas.width / 2;
		const centerY = canvas.height / 2;
		const maxRadius = Math.min(canvas.width, canvas.height) * 0.42; // Circular boundary
		const repulsion = 2500; // Strong repulsion to prevent overlap
		const attraction = 0.015; // Gentle attraction along edges
		const damping = 0.75;
		const centerPull = 0.006; // Gentle center pull
		const boundaryForce = 0.2; // Strong boundary to maintain circle

		// Create edge lookup for faster access
		const edgeMap = new Map<string, typeof edges[0][]>();
		for (const edge of edges) {
			if (!edgeMap.has(edge.source)) edgeMap.set(edge.source, []);
			if (!edgeMap.has(edge.target)) edgeMap.set(edge.target, []);
			edgeMap.get(edge.source)!.push(edge);
			edgeMap.get(edge.target)!.push(edge);
		}

		// Animation loop
		let frameCount = 0;
		const maxFrames = 400; // More frames for better settling

		const animate = () => {
			if (!ctx) return;
			frameCount++;

			// Apply forces only for first N frames and when not dragging a node
			if (frameCount < maxFrames && !draggedNode) {
				// Adaptive cooling - forces get weaker over time
				const cooling = Math.max(0.1, 1 - frameCount / maxFrames);

				// Repulsion between all nodes
				for (let i = 0; i < nodes.length; i++) {
					for (let j = i + 1; j < nodes.length; j++) {
						const dx = nodes[j].x - nodes[i].x;
						const dy = nodes[j].y - nodes[i].y;
						const dist = Math.max(30, Math.sqrt(dx * dx + dy * dy)); // Min distance prevents extreme forces
						const force = (repulsion / (dist * dist)) * cooling;
						const fx = (dx / dist) * force;
						const fy = (dy / dist) * force;
						nodes[i].vx -= fx;
						nodes[i].vy -= fy;
						nodes[j].vx += fx;
						nodes[j].vy += fy;
					}
				}

				// Attraction along edges
				for (const edge of edges) {
					const source = nodes.find(n => n.id === edge.source);
					const target = nodes.find(n => n.id === edge.target);
					if (source && target) {
						const dx = target.x - source.x;
						const dy = target.y - source.y;
						const force = attraction * edge.weight * cooling;
						source.vx += dx * force;
						source.vy += dy * force;
						target.vx -= dx * force;
						target.vy -= dy * force;
					}
				}

				// Center pull and boundary constraint
				for (const node of nodes) {
					const dx = node.x - centerX;
					const dy = node.y - centerY;
					const distFromCenter = Math.sqrt(dx * dx + dy * dy);

					// Always pull toward center
					node.vx += (centerX - node.x) * centerPull;
					node.vy += (centerY - node.y) * centerPull;

					// Strong boundary force if outside max radius
					if (distFromCenter > maxRadius) {
						const overflowRatio = (distFromCenter - maxRadius) / maxRadius;
						node.vx -= (dx / distFromCenter) * boundaryForce * overflowRatio * distFromCenter;
						node.vy -= (dy / distFromCenter) * boundaryForce * overflowRatio * distFromCenter;
					}
				}

				// Update positions with damping
				for (const node of nodes) {
					node.vx *= damping;
					node.vy *= damping;
					node.x += node.vx;
					node.y += node.vy;
				}
			}

			// Clear canvas
			ctx.clearRect(0, 0, canvas.width, canvas.height);

			// Save context and apply transform
			ctx.save();
			ctx.translate(offsetX, offsetY);
			ctx.scale(scale, scale);

			// Draw edges
			for (const edge of edges) {
				const source = nodes.find(n => n.id === edge.source);
				const target = nodes.find(n => n.id === edge.target);
				if (source && target) {
					const isHighlighted = (hoveredNode && (edge.source === hoveredNode.id || edge.target === hoveredNode.id)) ||
						(selectedNode && (edge.source === selectedNode.id || edge.target === selectedNode.id));
					ctx.beginPath();
					ctx.moveTo(source.x, source.y);
					ctx.lineTo(target.x, target.y);
					ctx.lineWidth = (isHighlighted ? Math.min(4, edge.weight + 1) : Math.min(3, edge.weight * 0.5 + 0.5)) / scale;
					ctx.strokeStyle = isHighlighted ? 'var(--interactive-accent)' : 'rgba(128, 128, 128, 0.3)';
					ctx.stroke();
				}
			}

			// Draw nodes
			for (const node of nodes) {
				const radius = Math.max(8, Math.min(25, node.count * 2));
				const isHovered = hoveredNode === node;
				const isSelected = selectedNode === node;
				const isDragged = draggedNode === node;
				const isConnected = (hoveredNode && edgeMap.get(hoveredNode.id)?.some(e => e.source === node.id || e.target === node.id)) ||
					(selectedNode && edgeMap.get(selectedNode.id)?.some(e => e.source === node.id || e.target === node.id));

				ctx.beginPath();
				ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
				ctx.fillStyle = isSelected ? 'var(--interactive-accent)' : (isHovered || isDragged ? 'var(--interactive-accent)' : (isConnected ? 'var(--interactive-accent-hover)' : node.color));
				ctx.fill();

				if (isHovered || isSelected || isDragged) {
					ctx.strokeStyle = 'var(--text-normal)';
					ctx.lineWidth = 2 / scale;
					ctx.stroke();
				}

				// Draw label for larger nodes, hovered, selected, dragged, or connected
				if (radius > 12 || isHovered || isSelected || isDragged || isConnected) {
					ctx.fillStyle = 'var(--text-normal)';
					const fontSize = ((isHovered || isSelected || isDragged) ? 12 : 11) / scale;
					ctx.font = `${(isHovered || isSelected || isDragged) ? 'bold ' : ''}${fontSize}px sans-serif`;
					ctx.textAlign = 'center';
					ctx.textBaseline = 'middle';
					ctx.fillText(node.label, node.x, node.y + radius + 12 / scale);
				}
			}

			// Restore context
			ctx.restore();

			// Draw zoom indicator (outside transform)
			if (scale !== 1) {
				ctx.fillStyle = 'var(--text-muted)';
				ctx.font = '11px sans-serif';
				ctx.textAlign = 'left';
				ctx.fillText(`${Math.round(scale * 100)}%`, 10, canvas.height - 10);
			}

			this.graphAnimationId = requestAnimationFrame(animate);
		};

		animate();
	}

	private buildTagCooccurrenceGraph(): { nodes: Array<{ id: string; label: string; count: number; x: number; y: number; vx: number; vy: number; color: string }>; edges: Array<{ source: string; target: string; weight: number }> } {
		const tagCounts = new Map<string, { count: number; categories: Map<string, number> }>();
		const cooccurrence = new Map<string, number>();

		// Count tags and track co-occurrences
		for (const memory of this.memories) {
			if (!memory.tags || memory.tags.length === 0) continue;

			const normalizedTags = memory.tags.map(t => t.toLowerCase());

			for (const tag of normalizedTags) {
				if (!tagCounts.has(tag)) {
					tagCounts.set(tag, { count: 0, categories: new Map() });
				}
				const data = tagCounts.get(tag)!;
				data.count++;
				const cat = memory.category || 'other';
				data.categories.set(cat, (data.categories.get(cat) || 0) + 1);
			}

			// Track co-occurrences (pairs)
			for (let i = 0; i < normalizedTags.length; i++) {
				for (let j = i + 1; j < normalizedTags.length; j++) {
					const key = [normalizedTags[i], normalizedTags[j]].sort().join('|');
					cooccurrence.set(key, (cooccurrence.get(key) || 0) + 1);
				}
			}
		}

		// Category colors
		const categoryColors: Record<string, string> = {
			work: '#6366f1',
			system: '#8b5cf6',
			skills: '#ec4899',
			interests: '#f59e0b',
			interesting: '#10b981',
			lifestyle: '#06b6d4',
			hobbies: '#84cc16',
			habits: '#f97316',
			core: '#ef4444',
			other: '#6b7280',
			manual: '#a855f7'
		};

		// Build nodes
		const nodes = Array.from(tagCounts.entries()).map(([tag, data]) => {
			// Get dominant category for color
			let dominantCat = 'other';
			let maxCount = 0;
			for (const [cat, count] of data.categories) {
				if (count > maxCount) {
					maxCount = count;
					dominantCat = cat;
				}
			}
			return {
				id: tag,
				label: tag,
				count: data.count,
				x: 0,
				y: 0,
				vx: 0,
				vy: 0,
				color: categoryColors[dominantCat] || categoryColors.other
			};
		});

		// Build edges
		const edges = Array.from(cooccurrence.entries()).map(([key, weight]) => {
			const [source, target] = key.split('|');
			return { source, target, weight };
		});

		return { nodes, edges };
	}

	private renderConversationsTab(container: HTMLElement): void {
		const tabContent = container.createDiv('omi-conversations-container');

		// View Mode Tabs (Daily, Stats, Heatmap, Map)
		this.renderConversationsViewModeTabs(tabContent);

		const currentViewMode = this.plugin.settings.conversationsViewMode || 'list';

		// Sync Controls Section
		const syncControls = tabContent.createDiv('omi-conversations-sync-controls');

		// Sync status info
		const statusInfo = syncControls.createDiv('omi-sync-status');
		const lastSync = this.plugin.settings.lastConversationSyncTimestamp;
		if (lastSync) {
			const lastSyncDate = new Date(lastSync);
			statusInfo.createEl('div', {
				text: `Last synced: ${lastSyncDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at ${lastSyncDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
			});
		} else {
			statusInfo.createEl('div', { text: 'Never synced' });
		}
		const syncedCount = Object.keys(this.plugin.settings.syncedConversations || {}).length;
		statusInfo.createEl('div', { text: `${syncedCount} conversations tracked`, cls: 'omi-sync-count' });

		// Sync buttons
		const syncButtons = syncControls.createDiv('omi-sync-buttons');

		const syncNewBtn = syncButtons.createEl('button', {
			text: this.isSyncingConversations ? 'Syncing...' : 'Sync New',
			cls: 'omi-sync-new-btn'
		});
		syncNewBtn.disabled = this.isSyncingConversations;
		syncNewBtn.addEventListener('click', () => this.handleConversationSync(false));

		const fullResyncBtn = syncButtons.createEl('button', {
			text: 'Full Resync',
			cls: 'omi-full-resync-btn'
		});
		fullResyncBtn.disabled = this.isSyncingConversations;
		fullResyncBtn.addEventListener('click', () => this.handleConversationSync(true));

		// Render the appropriate view based on mode
		switch (currentViewMode) {
			case 'list':
			case 'timeline':
				// Both list and timeline now use the unified daily view
				this.renderConversationsDailyView(tabContent);
				break;
			case 'stats':
				this.renderConversationsStats(tabContent);
				break;
			case 'heatmap':
				this.renderConversationsHeatmap(tabContent);
				break;
			case 'map':
				this.renderConversationsMap(tabContent);
				break;
			default:
				this.renderConversationsDailyView(tabContent);
		}
	}

	private renderConversationsViewModeTabs(container: HTMLElement): void {
		const tabs = container.createDiv('omi-conversations-view-tabs');
		tabs.setAttribute('role', 'tablist');
		tabs.setAttribute('aria-label', 'Conversation view modes');

		const currentMode = this.plugin.settings.conversationsViewMode || 'list';
		// Daily view combines timeline + cards, so we map both 'list' and 'timeline' to 'list'
		const effectiveMode = currentMode === 'timeline' ? 'list' : currentMode;
		const modes: Array<{ id: 'list' | 'stats' | 'heatmap' | 'map'; label: string; icon: string }> = [
			{ id: 'list', label: 'Daily', icon: '📅' },
			{ id: 'stats', label: 'Stats', icon: '📊' },
			{ id: 'heatmap', label: 'Heatmap', icon: '🔥' },
			{ id: 'map', label: 'Map', icon: '🗺️' }
		];

		for (const mode of modes) {
			const tab = tabs.createEl('button', {
				text: `${mode.icon} ${mode.label}`,
				cls: `omi-conv-view-tab ${effectiveMode === mode.id ? 'active' : ''}`
			});
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', String(effectiveMode === mode.id));
			tab.setAttribute('aria-label', `${mode.label} view`);
			tab.addEventListener('click', async () => {
				this.plugin.settings.conversationsViewMode = mode.id;
				await this.plugin.saveSettings();
				this.render();
			});
		}
	}

	private async handleConversationSync(fullResync: boolean): Promise<void> {
		this.isSyncingConversations = true;
		this.render();

		try {
			await this.plugin.syncConversations(fullResync);
		} finally {
			this.isSyncingConversations = false;
			this.render();
		}
	}

	private renderConversationCard(container: HTMLElement, conv: SyncedConversationMeta, showDate = false): void {
		const isSelected = this.selectedConversationId === conv.id;
		const card = container.createDiv(`omi-conversation-card${isSelected ? ' selected' : ''}`);
		card.setAttribute('role', 'button');
		card.setAttribute('tabindex', '0');
		card.setAttribute('aria-selected', String(isSelected));

		// Header row: emoji, title, time
		const header = card.createDiv('omi-conversation-card-header');
		header.createEl('span', { text: conv.emoji || '💬', cls: 'omi-conversation-emoji' });
		header.createEl('span', { text: conv.title || 'Untitled', cls: 'omi-conversation-title' });
		const timeText = showDate
			? `${new Date(conv.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${conv.time}`
			: conv.time;
		header.createEl('span', { text: timeText, cls: 'omi-conversation-time' });

		// Duration bar (visual representation)
		if (conv.duration && conv.duration > 0) {
			const durationBar = card.createDiv('omi-conversation-duration-bar');
			// Max width at 60 min, min at 1 min
			const barWidth = Math.min(100, Math.max(5, (conv.duration / 60) * 100));
			const barFill = durationBar.createDiv('omi-conversation-duration-fill');
			barFill.style.width = `${barWidth}%`;
			durationBar.createEl('span', {
				text: this.formatDuration(conv.duration),
				cls: 'omi-conversation-duration-text'
			});
		}

		// Meta row: tasks count, events count
		const meta = card.createDiv('omi-conversation-card-meta');
		if (conv.actionItemCount && conv.actionItemCount > 0) {
			meta.createEl('span', { text: `📝 ${conv.actionItemCount} task${conv.actionItemCount > 1 ? 's' : ''}`, cls: 'omi-conversation-meta-item' });
		}
		if (conv.eventCount && conv.eventCount > 0) {
			meta.createEl('span', { text: `📅 ${conv.eventCount} event${conv.eventCount > 1 ? 's' : ''}`, cls: 'omi-conversation-meta-item' });
		}
		if (conv.category) {
			meta.createEl('span', { text: conv.category, cls: 'omi-conversation-category' });
		}

		// Overview snippet
		if (conv.overview) {
			const snippet = card.createDiv('omi-conversation-overview');
			const text = conv.overview.length > 100 ? conv.overview.substring(0, 100) + '...' : conv.overview;
			snippet.setText(`"${text}"`);
		}

		// Click handler - select conversation to show in detail pane
		const handleClick = async () => {
			this.selectedConversationId = conv.id;
			this.detailTab = 'summary';
			await this.loadConversationDetails(conv.id);
			this.render();
		};
		card.addEventListener('click', handleClick);
		card.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				handleClick();
			}
		});
	}

	private compareTime(timeA: string, timeB: string): number {
		const parseTime = (timeStr: string): number => {
			const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
			if (!match) return 0;
			let hours = parseInt(match[1], 10);
			const minutes = parseInt(match[2], 10);
			const isPM = match[3].toUpperCase() === 'PM';
			if (isPM && hours !== 12) hours += 12;
			if (!isPM && hours === 12) hours = 0;
			return hours * 60 + minutes;
		};
		return parseTime(timeA) - parseTime(timeB);
	}

	private formatDuration(minutes: number): string {
		if (minutes < 60) {
			return `${minutes} min`;
		}
		const hours = Math.floor(minutes / 60);
		const mins = minutes % 60;
		return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	}

	private getWeekStartDate(date?: Date): Date {
		const d = date ? new Date(date) : new Date(this.calendarCurrentDate);
		const day = d.getDay();
		d.setDate(d.getDate() - day); // Go to Sunday
		d.setHours(0, 0, 0, 0);
		return d;
	}

	private async openConversationFile(conv: SyncedConversationMeta): Promise<void> {
		// Try to open the index file for that date
		const folderPath = this.plugin.settings.folderPath;
		const filePath = `${folderPath}/${conv.date}/${conv.date}.md`;

		const file = this.app.vault.getFileByPath(filePath);
		if (file) {
			await this.app.workspace.openLinkText(filePath, '', false);
		} else {
			// Fallback to overview if index doesn't exist
			const overviewPath = `${folderPath}/${conv.date}/overview.md`;
			const overviewFile = this.app.vault.getFileByPath(overviewPath);
			if (overviewFile) {
				await this.app.workspace.openLinkText(overviewPath, '', false);
			} else {
				new Notice('Conversation file not found. Try resyncing.');
			}
		}
	}

	// ==================== DETAIL PANEL ====================

	private renderConversationDetailPanel(container: HTMLElement): void {
		if (!this.selectedConversationId) return;

		const conv = this.plugin.settings.syncedConversations[this.selectedConversationId];
		if (!conv) {
			this.selectedConversationId = null;
			return;
		}

		// Header with title and close button
		const header = container.createDiv('omi-detail-header');

		const titleArea = header.createDiv('omi-detail-title-area');
		titleArea.createEl('span', { text: conv.emoji || '💬', cls: 'omi-detail-emoji' });
		titleArea.createEl('h3', { text: conv.title || 'Untitled', cls: 'omi-detail-title' });

		const closeBtn = header.createEl('button', { text: '×', cls: 'omi-detail-close' });
		closeBtn.setAttribute('aria-label', 'Close detail panel');
		closeBtn.addEventListener('click', () => {
			this.selectedConversationId = null;
			this.selectedConversationData = null;
			this.render();
		});

		// Meta info
		const meta = container.createDiv('omi-detail-meta');
		meta.createEl('span', { text: conv.time });
		if (conv.duration) {
			meta.createEl('span', { text: '•' });
			meta.createEl('span', { text: this.formatDuration(conv.duration) });
		}
		if (conv.category) {
			meta.createEl('span', { text: '•' });
			meta.createEl('span', { text: conv.category, cls: 'omi-detail-category' });
		}

		// Tab bar
		this.renderDetailTabs(container);

		// Tab content
		const content = container.createDiv('omi-detail-content');
		if (this.isLoadingDetail) {
			content.createDiv('omi-detail-loading').setText('Loading...');
		} else if (this.detailTab === 'summary') {
			this.renderDetailSummaryTab(content, conv);
		} else {
			this.renderDetailTranscriptTab(content);
		}

		// Footer with Open File button
		const footer = container.createDiv('omi-detail-footer');
		const openBtn = footer.createEl('button', { text: '📄 Open File', cls: 'omi-detail-open-btn' });
		openBtn.addEventListener('click', () => this.openConversationFile(conv));
	}

	private renderDetailTabs(container: HTMLElement): void {
		const tabs = container.createDiv('omi-detail-tabs');
		tabs.setAttribute('role', 'tablist');

		const summaryTab = tabs.createEl('button', {
			text: '📝 Summary',
			cls: `omi-detail-tab ${this.detailTab === 'summary' ? 'active' : ''}`
		});
		summaryTab.setAttribute('role', 'tab');
		summaryTab.setAttribute('aria-selected', String(this.detailTab === 'summary'));
		summaryTab.addEventListener('click', () => {
			this.detailTab = 'summary';
			this.render();
		});

		const transcriptTab = tabs.createEl('button', {
			text: '💬 Transcript',
			cls: `omi-detail-tab ${this.detailTab === 'transcript' ? 'active' : ''}`
		});
		transcriptTab.setAttribute('role', 'tab');
		transcriptTab.setAttribute('aria-selected', String(this.detailTab === 'transcript'));
		transcriptTab.addEventListener('click', () => {
			this.detailTab = 'transcript';
			this.render();
		});
	}

	private renderDetailSummaryTab(container: HTMLElement, conv: SyncedConversationMeta): void {
		const hasFileData = this.selectedConversationData &&
			(this.selectedConversationData.overview ||
			 this.selectedConversationData.actionItems.length > 0 ||
			 this.selectedConversationData.events.length > 0);

		// Fallback to metadata overview if file parsing returned nothing
		if (!hasFileData && conv.overview) {
			const overviewSection = container.createDiv('omi-detail-section');
			overviewSection.createEl('h4', { text: 'Overview' });
			const overviewText = conv.overview.length >= 150 ? conv.overview + '...' : conv.overview;
			overviewSection.createEl('p', { text: overviewText, cls: 'omi-detail-overview-text' });

			// Show counts from metadata if available
			const metaInfo = container.createDiv('omi-detail-section omi-detail-meta-summary');
			if (conv.actionItemCount > 0) {
				metaInfo.createEl('p', { text: `📝 ${conv.actionItemCount} action item${conv.actionItemCount > 1 ? 's' : ''} recorded` });
			}
			if (conv.eventCount > 0) {
				metaInfo.createEl('p', { text: `📅 ${conv.eventCount} event${conv.eventCount > 1 ? 's' : ''} detected` });
			}

			// Hint about full resync
			container.createEl('p', {
				text: 'Full details available after file resync.',
				cls: 'omi-detail-empty omi-detail-resync-hint'
			});
			return;
		}

		if (!this.selectedConversationData) {
			container.createEl('p', { text: 'No data available. Try resyncing.', cls: 'omi-detail-empty' });
			return;
		}

		// Overview section
		if (this.selectedConversationData.overview) {
			const overviewSection = container.createDiv('omi-detail-section');
			overviewSection.createEl('h4', { text: 'Overview' });
			overviewSection.createEl('p', { text: this.selectedConversationData.overview, cls: 'omi-detail-overview-text' });
		}

		// Action Items section
		if (this.selectedConversationData.actionItems.length > 0) {
			const tasksSection = container.createDiv('omi-detail-section');
			tasksSection.createEl('h4', { text: `Action Items (${this.selectedConversationData.actionItems.length})` });
			const taskList = tasksSection.createEl('ul', { cls: 'omi-detail-tasks' });
			for (const item of this.selectedConversationData.actionItems) {
				const li = taskList.createEl('li', { cls: item.completed ? 'completed' : '' });
				li.createEl('span', { text: item.completed ? '☑' : '☐', cls: 'omi-detail-task-check' });
				li.createEl('span', { text: item.description, cls: 'omi-detail-task-desc' });
			}
		}

		// Events section
		if (this.selectedConversationData.events.length > 0) {
			const eventsSection = container.createDiv('omi-detail-section');
			eventsSection.createEl('h4', { text: `Events (${this.selectedConversationData.events.length})` });
			const eventList = eventsSection.createEl('ul', { cls: 'omi-detail-events' });
			for (const event of this.selectedConversationData.events) {
				const li = eventList.createEl('li');
				li.createEl('span', { text: '📅', cls: 'omi-detail-event-icon' });
				li.createEl('span', { text: event.title, cls: 'omi-detail-event-title' });
				if (event.start) {
					li.createEl('span', { text: ` - ${event.start}`, cls: 'omi-detail-event-time' });
				}
			}
		}

		// Show empty message if no content at all
		if (!this.selectedConversationData.overview &&
			this.selectedConversationData.actionItems.length === 0 &&
			this.selectedConversationData.events.length === 0 &&
			!conv.overview) {
			container.createEl('p', { text: 'No summary content available for this conversation.', cls: 'omi-detail-empty' });
		}
	}

	private renderDetailTranscriptTab(container: HTMLElement): void {
		if (!this.selectedConversationData?.transcript || this.selectedConversationData.transcript.length === 0) {
			container.createEl('p', { text: 'No transcript available for this conversation.', cls: 'omi-detail-empty' });
			return;
		}

		const transcriptContainer = container.createDiv('omi-detail-transcript');

		for (const segment of this.selectedConversationData.transcript) {
			const segDiv = transcriptContainer.createDiv('omi-transcript-segment');

			if (segment.speaker) {
				const speakerLabel = segDiv.createEl('span', { cls: 'omi-transcript-speaker' });
				speakerLabel.setText(segment.speaker);
			}

			const textEl = segDiv.createEl('span', { cls: 'omi-transcript-text' });
			textEl.setText(segment.text);
		}
	}

	private async loadConversationDetails(convId: string): Promise<void> {
		const conv = this.plugin.settings.syncedConversations[convId];
		if (!conv) return;

		this.isLoadingDetail = true;
		this.selectedConversationData = null;

		try {
			const folderPath = this.plugin.settings.folderPath;
			const basePath = `${folderPath}/${conv.date}`;

			// Read and parse overview
			const overviewPath = `${basePath}/overview.md`;
			const overview = await this.extractConversationSection(overviewPath, conv.id, conv.time, conv.emoji, conv.title);

			// Read and parse action items
			const actionsPath = `${basePath}/action-items.md`;
			const actionItems = await this.parseActionItemsFromFile(actionsPath, conv.id, conv.time, conv.emoji, conv.title);

			// Read and parse events
			const eventsPath = `${basePath}/events.md`;
			const events = await this.parseEventsFromFile(eventsPath, conv.id, conv.time, conv.emoji, conv.title);

			// Read and parse transcript
			const transcriptPath = `${basePath}/transcript.md`;
			const transcript = await this.parseTranscriptFromFile(transcriptPath, conv.id, conv.time, conv.emoji, conv.title);

			this.selectedConversationData = { overview, actionItems, events, transcript };
		} catch (error) {
			console.error('Error loading conversation details:', error);
			this.selectedConversationData = { overview: '', actionItems: [], events: [], transcript: [] };
		} finally {
			this.isLoadingDetail = false;
		}
	}

	private async extractConversationSection(filePath: string, convId: string, time: string, emoji: string, title: string): Promise<string> {
		const file = this.app.vault.getFileByPath(filePath);
		if (!file) return '';

		const content = await this.app.vault.read(file);
		const lines = content.split('\n');

		let headerIndex = -1;

		// Strategy 1: Match by conversation ID (preferred, for new files)
		const idComment = `<!-- conv_id: ${convId} -->`;
		const idLineIndex = lines.findIndex(line => line.trim() === idComment);
		if (idLineIndex > 0) {
			// Header is the line before the ID comment
			headerIndex = idLineIndex - 1;
		}

		// Strategy 2: Fallback to header matching for old files without ID
		if (headerIndex === -1) {
			const sectionHeader = `#### ${time} - ${emoji} ${title}`;
			headerIndex = lines.findIndex(line => line.startsWith(sectionHeader) || line.includes(`${time} - ${emoji}`));
		}

		if (headerIndex === -1) return '';

		// Extract content until the next section header or end of file
		const sectionLines: string[] = [];
		for (let i = headerIndex + 1; i < lines.length; i++) {
			const line = lines[i];
			// Skip the ID comment line
			if (line.startsWith('<!-- conv_id:')) continue;
			// Skip internal Obsidian link lines like "*([[transcript#...|Transcript]])*" or "*([[overview#...|Overview]])*"
			if (line.trim().startsWith('*([[') && line.trim().endsWith(']])*')) continue;
			// Stop at next section header (starts with ####)
			if (line.startsWith('####')) break;
			sectionLines.push(line);
		}

		return sectionLines.join('\n').trim();
	}

	private async parseActionItemsFromFile(filePath: string, convId: string, time: string, emoji: string, title: string): Promise<ActionItem[]> {
		const sectionContent = await this.extractConversationSection(filePath, convId, time, emoji, title);
		if (!sectionContent) return [];

		const items: ActionItem[] = [];
		const lines = sectionContent.split('\n');

		for (const line of lines) {
			// Match markdown checkboxes: - [ ] or - [x]
			const match = line.match(/^-\s*\[([ xX])\]\s*(.+)/);
			if (match) {
				items.push({
					completed: match[1].toLowerCase() === 'x',
					description: match[2].trim()
				});
			}
		}

		return items;
	}

	private async parseEventsFromFile(filePath: string, convId: string, time: string, emoji: string, title: string): Promise<CalendarEvent[]> {
		const sectionContent = await this.extractConversationSection(filePath, convId, time, emoji, title);
		if (!sectionContent) return [];

		const events: CalendarEvent[] = [];
		const lines = sectionContent.split('\n');

		for (const line of lines) {
			// Match event format: "- **Event Title** - Start Time (Duration)" or similar patterns
			const bulletMatch = line.match(/^-\s*\*\*(.+?)\*\*(?:\s*-\s*(.+))?/);
			if (bulletMatch) {
				events.push({
					title: bulletMatch[1].trim(),
					start: bulletMatch[2]?.trim() || '',
					duration: 0
				});
			} else {
				// Simple bullet format
				const simpleMatch = line.match(/^-\s+(.+)/);
				if (simpleMatch && simpleMatch[1].trim()) {
					events.push({
						title: simpleMatch[1].trim(),
						start: '',
						duration: 0
					});
				}
			}
		}

		return events;
	}

	private async parseTranscriptFromFile(filePath: string, convId: string, time: string, emoji: string, title: string): Promise<TranscriptSegment[]> {
		const sectionContent = await this.extractConversationSection(filePath, convId, time, emoji, title);
		if (!sectionContent) return [];

		const segments: TranscriptSegment[] = [];
		const lines = sectionContent.split('\n');

		for (const line of lines) {
			// Match transcript format: "**Speaker 0** (0:00): text"
			const timestampMatch = line.match(/^\*\*(.+?)\*\*\s*\(([^)]+)\):\s*(.+)/);
			if (timestampMatch) {
				segments.push({
					speaker: timestampMatch[1].trim(),
					text: timestampMatch[3].trim(),
					start: 0
				});
				continue;
			}

			// Match format: "**Speaker X:** text" (colon inside bold)
			const boldMatch = line.match(/^\*\*(.+?):\*\*\s*(.+)/);
			if (boldMatch) {
				segments.push({
					speaker: boldMatch[1].trim(),
					text: boldMatch[2].trim(),
					start: 0
				});
				continue;
			}

			// Non-bold format: "Speaker X: text"
			const simpleMatch = line.match(/^([^:]+):\s*(.+)/);
			if (simpleMatch && simpleMatch[1].length < 30) { // Likely a speaker label
				segments.push({
					speaker: simpleMatch[1].trim(),
					text: simpleMatch[2].trim(),
					start: 0
				});
			} else if (line.trim() && segments.length > 0) {
				// Append to previous segment if it's a continuation
				segments[segments.length - 1].text += ' ' + line.trim();
			} else if (line.trim()) {
				// Standalone text without speaker
				segments.push({
					text: line.trim(),
					start: 0
				});
			}
		}

		return segments;
	}

	private parseTimeToMinutes(timeStr: string): number {
		const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
		if (!match) return -1;
		let hours = parseInt(match[1], 10);
		const minutes = parseInt(match[2], 10);
		const isPM = match[3].toUpperCase() === 'PM';
		if (isPM && hours !== 12) hours += 12;
		if (!isPM && hours === 12) hours = 0;
		return hours * 60 + minutes;
	}

	// ==================== UNIFIED DAILY VIEW ====================

	private renderConversationsDailyView(container: HTMLElement): void {
		const dailyContainer = container.createDiv('omi-conversations-daily');

		const sortedDates = this.getSortedUniqueDates();
		if (sortedDates.length === 0) {
			this.renderEmptyConversationsState(dailyContainer);
			return;
		}

		// Resolve current date (use selected or default to most recent)
		const currentDate = this.dailyViewSelectedDate || sortedDates[0];
		const dateIndex = sortedDates.indexOf(currentDate);

		// If selected date not found, reset to most recent
		if (dateIndex === -1) {
			this.dailyViewSelectedDate = sortedDates[0];
		}

		const displayDate = dateIndex >= 0 ? currentDate : sortedDates[0];
		const displayIndex = dateIndex >= 0 ? dateIndex : 0;

		// 1. Date Navigation Header
		this.renderDateNavigationHeader(dailyContainer, displayDate, sortedDates, displayIndex);

		// 2. Timeline Section
		this.renderDailyTimelineSection(dailyContainer, displayDate);

		// 3. Split container for cards + detail
		this.renderDailyCardsSection(dailyContainer, displayDate);
	}

	private renderEmptyConversationsState(container: HTMLElement): void {
		const empty = container.createDiv('omi-conversations-empty');
		empty.createEl('div', { text: '💬', cls: 'omi-empty-icon' });
		empty.createEl('h3', { text: 'No conversations synced' });
		empty.createEl('p', { text: 'Click "Sync New" above to fetch your Omi conversations' });
	}

	private renderDateNavigationHeader(
		container: HTMLElement,
		currentDate: string,
		sortedDates: string[],
		dateIndex: number
	): void {
		const nav = container.createDiv('omi-daily-nav');

		// Older button
		const prevBtn = nav.createEl('button', { text: '◀ Older', cls: 'omi-timeline-nav-btn' });
		prevBtn.disabled = dateIndex >= sortedDates.length - 1;
		prevBtn.addEventListener('click', () => {
			if (dateIndex < sortedDates.length - 1) {
				this.dailyViewSelectedDate = sortedDates[dateIndex + 1];
				this.selectedConversationId = null;
				this.selectedConversationData = null;
				this.render();
			}
		});

		// Date label (clickable for calendar picker)
		const dateLabel = nav.createEl('span', {
			text: new Date(currentDate + 'T00:00:00').toLocaleDateString('en-US', {
				weekday: 'long',
				month: 'long',
				day: 'numeric',
				year: 'numeric'
			}),
			cls: 'omi-timeline-date-label omi-clickable'
		});
		dateLabel.setAttribute('role', 'button');
		dateLabel.setAttribute('tabindex', '0');
		dateLabel.setAttribute('aria-label', 'Click to pick a date');
		dateLabel.addEventListener('click', () => this.showConversationDatePicker(currentDate, sortedDates));
		dateLabel.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.showConversationDatePicker(currentDate, sortedDates);
			}
		});

		// Newer button
		const nextBtn = nav.createEl('button', { text: 'Newer ▶', cls: 'omi-timeline-nav-btn' });
		nextBtn.disabled = dateIndex <= 0;
		nextBtn.addEventListener('click', () => {
			if (dateIndex > 0) {
				this.dailyViewSelectedDate = sortedDates[dateIndex - 1];
				this.selectedConversationId = null;
				this.selectedConversationData = null;
				this.render();
			}
		});
	}

	private showConversationDatePicker(currentDate: string, datesWithData: string[]): void {
		new CalendarDatePickerModal(
			this.app,
			datesWithData,
			currentDate,
			(selectedDate) => {
				this.dailyViewSelectedDate = selectedDate;
				this.selectedConversationId = null;
				this.selectedConversationData = null;
				this.render();
			}
		).open();
	}

	private renderDailyTimelineSection(container: HTMLElement, dateStr: string): void {
		const dayConvs = this.getConversationsForDate(dateStr);

		// Timeline grid
		const timeline = container.createDiv('omi-timeline-grid');

		// Hour labels
		const hoursRow = timeline.createDiv('omi-timeline-hours');
		for (let hour = 6; hour <= 23; hour++) {
			hoursRow.createEl('span', {
				text: hour <= 12 ? `${hour}${hour < 12 ? 'am' : 'pm'}` : `${hour - 12}pm`,
				cls: 'omi-timeline-hour'
			});
		}

		// Timeline track with blocks
		const track = timeline.createDiv('omi-timeline-track');
		for (const conv of dayConvs) {
			this.renderTimelineBlockSelectable(track, conv);
		}

		// Legend
		const legend = container.createDiv('omi-timeline-legend');
		legend.createEl('span', { text: `${dayConvs.length} conversation${dayConvs.length !== 1 ? 's' : ''}` });
		const totalDuration = dayConvs.reduce((sum, c) => sum + (c.duration || 0), 0);
		legend.createEl('span', { text: `Total: ${this.formatDuration(totalDuration)}` });
	}

	private renderTimelineBlockSelectable(track: HTMLElement, conv: SyncedConversationMeta): void {
		// Parse start time
		const startMinutes = this.parseTimeToMinutes(conv.time);
		if (startMinutes < 0) return;

		// Calculate position (6am = 0%, 11pm = 100%)
		const dayStartMinutes = 6 * 60;  // 6 AM
		const dayEndMinutes = 23 * 60;   // 11 PM
		const totalRange = dayEndMinutes - dayStartMinutes;

		const position = Math.max(0, Math.min(100, ((startMinutes - dayStartMinutes) / totalRange) * 100));
		const duration = conv.duration || 15;
		const width = Math.max(2, Math.min(30, (duration / totalRange) * 100));

		const isSelected = this.selectedConversationId === conv.id;
		const block = track.createDiv(`omi-timeline-block${isSelected ? ' selected' : ''}`);
		block.style.left = `${position}%`;
		block.style.width = `${width}%`;
		block.setAttribute('title', `${conv.emoji} ${conv.title}\n${conv.time} - ${this.formatDuration(duration)}`);
		block.setAttribute('role', 'button');
		block.setAttribute('tabindex', '0');

		// Color by category
		const categoryColors: Record<string, string> = {
			'business': 'var(--color-blue)',
			'education': 'var(--color-purple)',
			'technology': 'var(--color-cyan)',
			'personal': 'var(--color-green)',
			'family': 'var(--color-orange)',
			'health': 'var(--color-red)',
			'other': 'var(--color-gray)'
		};
		const color = categoryColors[conv.category?.toLowerCase() || 'other'] || 'var(--interactive-accent)';
		block.style.backgroundColor = color;

		block.createEl('span', { text: conv.emoji || '💬', cls: 'omi-timeline-block-emoji' });

		// Click to select conversation and show in detail panel
		const handleClick = async () => {
			this.selectedConversationId = conv.id;
			this.detailTab = 'summary';
			await this.loadConversationDetails(conv.id);
			this.render();
		};
		block.addEventListener('click', handleClick);
		block.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				handleClick();
			}
		});
	}

	private renderDailyCardsSection(container: HTMLElement, dateStr: string): void {
		const dayConvs = this.getConversationsForDate(dateStr);

		// Split container (cards left, detail right)
		const splitContainer = container.createDiv('omi-conversations-split');
		if (this.selectedConversationId) {
			splitContainer.addClass('has-selection');
		}

		// Left pane: cards
		const cardsPane = splitContainer.createDiv('omi-conversations-list-pane');

		if (dayConvs.length === 0) {
			const empty = cardsPane.createDiv('omi-conversations-empty-day');
			empty.createEl('div', { text: '📭', cls: 'omi-empty-icon' });
			empty.createEl('h3', { text: 'No conversations on this day' });
			empty.createEl('p', { text: 'Navigate to another date or sync more conversations' });
		} else {
			for (const conv of dayConvs) {
				this.renderConversationCard(cardsPane, conv, false);
			}
		}

		// Right pane: detail (if selected)
		if (this.selectedConversationId) {
			const detailPane = splitContainer.createDiv('omi-conversations-detail-pane');
			this.renderConversationDetailPanel(detailPane);
		}
	}

	// ==================== STATS DASHBOARD ====================

	private renderConversationsStats(container: HTMLElement): void {
		const statsContainer = container.createDiv('omi-conversations-stats');

		const conversations = this.plugin.settings.syncedConversations || {};
		const conversationArray = Object.values(conversations) as SyncedConversationMeta[];

		if (conversationArray.length === 0) {
			const empty = statsContainer.createDiv('omi-conversations-empty');
			empty.createEl('div', { text: '📊', cls: 'omi-empty-icon' });
			empty.createEl('h3', { text: 'No statistics available' });
			empty.createEl('p', { text: 'Sync conversations to see your stats' });
			return;
		}

		// Time range selector
		const timeRangeContainer = statsContainer.createDiv('omi-stats-time-range');
		const ranges: { key: 'week' | 'month' | '30days' | 'all'; label: string }[] = [
			{ key: 'all', label: 'All Time' },
			{ key: '30days', label: 'Last 30 Days' },
			{ key: 'month', label: 'This Month' },
			{ key: 'week', label: 'This Week' }
		];

		for (const range of ranges) {
			const btn = timeRangeContainer.createEl('button', {
				text: range.label,
				cls: `omi-stats-range-btn ${this.statsTimeRange === range.key ? 'active' : ''}`
			});
			btn.addEventListener('click', () => {
				this.statsTimeRange = range.key;
				this.render();
			});
		}

		// Filter conversations based on selected time range
		const now = new Date();
		let filteredConvs: SyncedConversationMeta[];
		let rangeLabel: string;

		switch (this.statsTimeRange) {
			case 'week': {
				const weekStart = this.getWeekStartDate(now);
				filteredConvs = conversationArray.filter(c => new Date(c.date + 'T00:00:00') >= weekStart);
				rangeLabel = 'This Week';
				break;
			}
			case 'month': {
				const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
				filteredConvs = conversationArray.filter(c => new Date(c.date + 'T00:00:00') >= monthStart);
				rangeLabel = 'This Month';
				break;
			}
			case '30days': {
				const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
				filteredConvs = conversationArray.filter(c => new Date(c.date + 'T00:00:00') >= thirtyDaysAgo);
				rangeLabel = 'Last 30 Days';
				break;
			}
			case 'all':
			default:
				filteredConvs = conversationArray;
				rangeLabel = 'All Time';
		}

		// Top stats cards
		const topStats = statsContainer.createDiv('omi-stats-top-row');

		// Conversation count
		const countCard = topStats.createDiv('omi-stats-card');
		countCard.createEl('div', { text: String(filteredConvs.length), cls: 'omi-stats-value' });
		countCard.createEl('div', { text: 'conversations', cls: 'omi-stats-label' });

		// Total time
		const totalDuration = filteredConvs.reduce((sum: number, c: SyncedConversationMeta) => sum + (c.duration || 0), 0);
		const timeCard = topStats.createDiv('omi-stats-card');
		timeCard.createEl('div', { text: this.formatDuration(totalDuration), cls: 'omi-stats-value' });
		timeCard.createEl('div', { text: 'total time', cls: 'omi-stats-label' });

		// Top category
		const categoryCount = new Map<string, number>();
		for (const conv of filteredConvs) {
			const cat = conv.category || 'other';
			categoryCount.set(cat, (categoryCount.get(cat) || 0) + 1);
		}
		let topCategory = 'N/A';
		let topCategoryCount = 0;
		for (const [cat, count] of categoryCount) {
			if (count > topCategoryCount) {
				topCategory = cat;
				topCategoryCount = count;
			}
		}
		const topCatCard = topStats.createDiv('omi-stats-card');
		topCatCard.createEl('div', { text: topCategory, cls: 'omi-stats-value omi-stats-category' });
		topCatCard.createEl('div', { text: 'top category', cls: 'omi-stats-label' });

		// Total tasks
		const totalTasks = filteredConvs.reduce((sum: number, c: SyncedConversationMeta) => sum + (c.actionItemCount || 0), 0);
		const tasksCard = topStats.createDiv('omi-stats-card');
		tasksCard.createEl('div', { text: String(totalTasks), cls: 'omi-stats-value' });
		tasksCard.createEl('div', { text: 'tasks created', cls: 'omi-stats-label' });

		// Total events
		const totalEvents = filteredConvs.reduce((sum: number, c: SyncedConversationMeta) => sum + (c.eventCount || 0), 0);
		const eventsCard = topStats.createDiv('omi-stats-card');
		eventsCard.createEl('div', { text: String(totalEvents), cls: 'omi-stats-value' });
		eventsCard.createEl('div', { text: 'events', cls: 'omi-stats-label' });

		// Category breakdown
		const categorySection = statsContainer.createDiv('omi-stats-section');
		categorySection.createEl('h4', { text: `Category Breakdown (${rangeLabel})` });

		const categoryDurations = new Map<string, number>();
		for (const conv of filteredConvs) {
			const cat = conv.category || 'other';
			categoryDurations.set(cat, (categoryDurations.get(cat) || 0) + (conv.duration || 0));
		}

		const sortedCategories = Array.from(categoryDurations.entries())
			.sort((a, b) => b[1] - a[1]);

		for (const [category, duration] of sortedCategories) {
			const catRow = categorySection.createDiv('omi-stats-category-row');

			const label = catRow.createDiv('omi-stats-category-label');
			label.createEl('span', { text: this.getCategoryEmoji(category) });
			label.createEl('span', { text: category });

			const barContainer = catRow.createDiv('omi-stats-bar-container');
			const bar = barContainer.createDiv('omi-stats-bar');
			const percentage = totalDuration > 0 ? (duration / totalDuration) * 100 : 0;
			bar.style.width = `${percentage}%`;

			catRow.createEl('span', {
				text: `${Math.round(percentage)}% (${this.formatDuration(duration)})`,
				cls: 'omi-stats-percentage'
			});
		}

		// Daily activity chart
		const dailySection = statsContainer.createDiv('omi-stats-section');
		dailySection.createEl('h4', { text: 'Daily Activity' });

		const dailyChart = dailySection.createDiv('omi-stats-daily-chart');
		const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

		// Count conversations per day of week
		const dayActivity = new Map<number, number>();
		for (const conv of filteredConvs) {
			const convDate = new Date(conv.date + 'T00:00:00');
			const dayOfWeek = convDate.getDay();
			dayActivity.set(dayOfWeek, (dayActivity.get(dayOfWeek) || 0) + 1);
		}

		const maxActivity = Math.max(...Array.from(dayActivity.values()), 1);

		for (let i = 0; i < 7; i++) {
			const dayBar = dailyChart.createDiv('omi-stats-day-bar');
			const count = dayActivity.get(i) || 0;
			const height = (count / maxActivity) * 100;

			const bar = dayBar.createDiv('omi-stats-day-fill');
			bar.style.height = `${height}%`;

			dayBar.createEl('span', { text: dayNames[i], cls: 'omi-stats-day-label' });
		}
	}

	private getCategoryEmoji(category: string): string {
		const emojis: Record<string, string> = {
			'business': '💼',
			'education': '📚',
			'technology': '💻',
			'personal': '🧘',
			'family': '👨‍👩‍👧',
			'health': '🏥',
			'entertainment': '🎬',
			'travel': '✈️',
			'food': '🍽️',
			'shopping': '🛒',
			'other': '💬'
		};
		return emojis[category.toLowerCase()] || '💬';
	}

	// ==================== HEATMAP VIEW ====================

	private renderConversationsHeatmap(container: HTMLElement): void {
		const heatmapContainer = container.createDiv('omi-conversations-heatmap');

		const conversations = this.plugin.settings.syncedConversations || {};
		const conversationArray = Object.values(conversations) as SyncedConversationMeta[];

		if (conversationArray.length === 0) {
			const empty = heatmapContainer.createDiv('omi-conversations-empty');
			empty.createEl('div', { text: '🔥', cls: 'omi-empty-icon' });
			empty.createEl('h3', { text: 'No heatmap data available' });
			empty.createEl('p', { text: 'Sync conversations to see your activity heatmap' });
			return;
		}

		// Count conversations per date
		const dateCount = new Map<string, number>();
		const dateDuration = new Map<string, number>();
		for (const conv of conversationArray) {
			dateCount.set(conv.date, (dateCount.get(conv.date) || 0) + 1);
			dateDuration.set(conv.date, (dateDuration.get(conv.date) || 0) + (conv.duration || 0));
		}

		// Show full year: Jan 1 to Dec 31 of current year
		const now = new Date();
		const currentYear = now.getFullYear();

		// Start from Jan 1, aligned to Sunday of that week
		const startDate = new Date(currentYear, 0, 1); // Jan 1
		startDate.setDate(startDate.getDate() - startDate.getDay()); // Align to Sunday

		// End at Dec 31, aligned to Saturday of that week
		const endDate = new Date(currentYear, 11, 31); // Dec 31
		endDate.setDate(endDate.getDate() + (6 - endDate.getDay())); // Align to Saturday

		// Year header
		const yearHeader = heatmapContainer.createDiv('omi-heatmap-year-header');
		yearHeader.createEl('span', { text: `${currentYear}`, cls: 'omi-heatmap-year' });

		// Heatmap header with month labels - calculate widths based on weeks per month
		const monthsRow = heatmapContainer.createDiv('omi-heatmap-months');
		monthsRow.createEl('span', { text: '', cls: 'omi-heatmap-spacer' }); // Spacer for day labels

		// Calculate weeks per month for proper label positioning
		let currentMonth = -1;
		let weeksInMonth = 0;
		const tempDate = new Date(startDate);
		const monthLabels: { month: string; weeks: number; year: number }[] = [];

		while (tempDate <= endDate) {
			if (tempDate.getMonth() !== currentMonth) {
				if (currentMonth !== -1) {
					monthLabels.push({
						month: new Date(tempDate.getFullYear(), currentMonth, 1)
							.toLocaleDateString('en-US', { month: 'short' }),
						weeks: weeksInMonth,
						year: tempDate.getFullYear()
					});
				}
				currentMonth = tempDate.getMonth();
				weeksInMonth = 0;
			}
			weeksInMonth++;
			tempDate.setDate(tempDate.getDate() + 7);
		}
		// Push final month
		if (weeksInMonth > 0) {
			monthLabels.push({
				month: new Date(tempDate.getFullYear(), currentMonth, 1)
					.toLocaleDateString('en-US', { month: 'short' }),
				weeks: weeksInMonth,
				year: tempDate.getFullYear()
			});
		}

		// Render month labels with proper widths (22px = 18px cell + 4px gap)
		for (const { month, weeks } of monthLabels) {
			const label = monthsRow.createEl('span', { text: month, cls: 'omi-heatmap-month' });
			label.style.width = `${weeks * 22}px`;
		}

		// Heatmap grid
		const grid = heatmapContainer.createDiv('omi-heatmap-grid');
		const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

		// Create 7 rows (Sun-Sat)
		for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
			const row = grid.createDiv('omi-heatmap-row');

			// Day label
			row.createEl('span', { text: dayLabels[dayOfWeek], cls: 'omi-heatmap-day-label' });

			// Cells for each week
			const cellDate = new Date(startDate);
			cellDate.setDate(cellDate.getDate() + dayOfWeek);

			while (cellDate <= endDate) {
				const dateStr = this.formatDateOnly(cellDate);
				const count = dateCount.get(dateStr) || 0;
				const duration = dateDuration.get(dateStr) || 0;

				const cell = row.createDiv('omi-heatmap-cell');

				// Set intensity level (0-4)
				let level = 0;
				if (count >= 5) level = 4;
				else if (count >= 3) level = 3;
				else if (count >= 2) level = 2;
				else if (count >= 1) level = 1;

				cell.addClass(`omi-heatmap-level-${level}`);
				cell.setAttribute('title', `${cellDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}\n${count} conversations\n${this.formatDuration(duration)}`);

				// Click to navigate to that day in daily view
				if (count > 0) {
					cell.addClass('clickable');
					const clickDate = this.formatDateOnly(new Date(cellDate));
					cell.addEventListener('click', () => {
						this.plugin.settings.conversationsViewMode = 'list';
						this.dailyViewSelectedDate = clickDate;
						this.plugin.saveSettings();
						this.render();
					});
				}

				cellDate.setDate(cellDate.getDate() + 7);
			}
		}

		// Legend
		const legend = heatmapContainer.createDiv('omi-heatmap-legend');
		legend.createEl('span', { text: 'Less' });
		for (let i = 0; i <= 4; i++) {
			const legendCell = legend.createDiv('omi-heatmap-cell omi-heatmap-legend-cell');
			legendCell.addClass(`omi-heatmap-level-${i}`);
		}
		legend.createEl('span', { text: 'More' });

		// Summary stats
		const summary = heatmapContainer.createDiv('omi-heatmap-summary');
		const totalConvs = conversationArray.length;
		const activeDays = dateCount.size;
		const avgPerDay = activeDays > 0 ? (totalConvs / activeDays).toFixed(1) : '0';

		const stat1 = summary.createEl('span');
		stat1.innerHTML = `<strong>${totalConvs}</strong> conversations in ${currentYear}`;
		const stat2 = summary.createEl('span');
		stat2.innerHTML = `<strong>${activeDays}</strong> active days`;
		const stat3 = summary.createEl('span');
		stat3.innerHTML = `<strong>${avgPerDay}</strong> avg/day`;
	}

	// Map view properties
	private leafletLoaded = false;
	private mapInstance: any = null;

	private async loadLeaflet(): Promise<void> {
		if (this.leafletLoaded && (window as any).L) return;

		// CSS is bundled in styles.css to avoid Obsidian CSP blocking external stylesheets
		// Only need to load the JS library (scripts from CDN are allowed)

		if (!(window as any).L) {
			await new Promise<void>((resolve, reject) => {
				const script = document.createElement('script');
				script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
				script.onload = () => resolve();
				script.onerror = () => reject(new Error('Failed to load Leaflet'));
				document.head.appendChild(script);
			});
		}

		this.leafletLoaded = true;
	}

	private renderConversationsMap(container: HTMLElement): void {
		const mapContainer = container.createDiv('omi-conversations-map');

		// Get conversations with geo data
		const conversationsWithGeo = Object.values(this.plugin.settings.syncedConversations)
			.filter(c => c.geolocation?.latitude && c.geolocation?.longitude);

		if (conversationsWithGeo.length === 0) {
			const emptyState = mapContainer.createDiv('omi-map-empty');
			emptyState.createEl('div', { text: '🗺️', cls: 'omi-map-empty-icon' });
			emptyState.createEl('h3', { text: 'No location data available' });
			emptyState.createEl('p', {
				text: 'Location is captured when using the Omi device. Do a Full Resync to load geo data for existing conversations.'
			});
			return;
		}

		// Stats bar
		const statsBar = mapContainer.createDiv('omi-map-stats');
		const uniqueLocations = this.groupConversationsByLocation(conversationsWithGeo);
		statsBar.createEl('span', {
			text: `📍 ${conversationsWithGeo.length} conversations across ${Object.keys(uniqueLocations).length} locations`
		});

		// Map container element
		const mapEl = mapContainer.createDiv('omi-map-container');
		mapEl.id = 'omi-leaflet-map-' + Date.now(); // Unique ID
		mapEl.style.height = '500px';

		// Load Leaflet and initialize map
		this.loadLeaflet().then(() => {
			this.initializeMap(mapEl, conversationsWithGeo, uniqueLocations);
		}).catch(err => {
			console.error('Failed to load Leaflet:', err);
			mapEl.createEl('p', {
				text: 'Failed to load map library. Please check your internet connection.',
				cls: 'omi-map-error'
			});
		});
	}

	private groupConversationsByLocation(conversations: SyncedConversationMeta[]): Record<string, SyncedConversationMeta[]> {
		const groups: Record<string, SyncedConversationMeta[]> = {};

		for (const conv of conversations) {
			if (!conv.geolocation) continue;
			// Round to ~100m precision for clustering
			const lat = Math.round(conv.geolocation.latitude * 1000) / 1000;
			const lng = Math.round(conv.geolocation.longitude * 1000) / 1000;
			const key = `${lat},${lng}`;

			if (!groups[key]) groups[key] = [];
			groups[key].push(conv);
		}

		return groups;
	}

	private initializeMap(
		mapEl: HTMLElement,
		conversations: SyncedConversationMeta[],
		locationGroups: Record<string, SyncedConversationMeta[]>
	): void {
		const L = (window as any).L;
		if (!L) return;

		// Clean up existing map if any
		if (this.mapInstance) {
			this.mapInstance.remove();
			this.mapInstance = null;
		}

		// Calculate bounds from all conversations
		const bounds = L.latLngBounds(
			conversations.map(c => [c.geolocation!.latitude, c.geolocation!.longitude])
		);

		// Initialize map
		this.mapInstance = L.map(mapEl).fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });

		// Add tile layer - using CartoDB which has better CORS support for Electron apps
		// Fallback chain: CartoDB Voyager -> CartoDB Positron -> OSM
		const tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
			subdomains: 'abcd',
			maxZoom: 19
		});
		tileLayer.addTo(this.mapInstance);

		// Multiple invalidateSize calls to ensure tiles load properly
		// This helps with Electron/Obsidian container rendering timing issues
		const invalidateSizes = () => {
			if (this.mapInstance) {
				this.mapInstance.invalidateSize();
			}
		};
		setTimeout(invalidateSizes, 100);
		setTimeout(invalidateSizes, 300);
		setTimeout(invalidateSizes, 500);

		// Add markers for each location group
		for (const [key, convs] of Object.entries(locationGroups)) {
			const [lat, lng] = key.split(',').map(Number);

			// Create custom purple marker icon
			const markerIcon = L.divIcon({
				className: 'omi-map-marker',
				html: `<div class="omi-map-marker-inner">${convs.length > 1 ? convs.length : ''}</div>`,
				iconSize: [32, 32],
				iconAnchor: [16, 32],
				popupAnchor: [0, -32]
			});

			const marker = L.marker([lat, lng], { icon: markerIcon })
				.addTo(this.mapInstance)
				.bindPopup(this.createMapPopupContent(convs), {
					maxWidth: 300,
					className: 'omi-map-popup-wrapper'
				});
		}
	}

	private createMapPopupContent(conversations: SyncedConversationMeta[]): string {
		const address = conversations[0].geolocation?.address || 'Unknown location';
		const items = conversations.slice(0, 5).map(c =>
			`<div class="omi-map-popup-item">
				<span class="omi-map-popup-emoji">${c.emoji}</span>
				<span class="omi-map-popup-title">${c.title}</span>
				<span class="omi-map-popup-date">${c.date}</span>
			</div>`
		).join('');

		const more = conversations.length > 5
			? `<div class="omi-map-popup-more">+${conversations.length - 5} more conversations</div>`
			: '';

		return `
			<div class="omi-map-popup">
				<div class="omi-map-popup-address">${address}</div>
				<div class="omi-map-popup-count">${conversations.length} conversation${conversations.length > 1 ? 's' : ''}</div>
				${items}
				${more}
			</div>
		`;
	}

	private renderLoadingSkeleton(container: HTMLElement): void {
		const skeleton = container.createDiv('omi-tasks-skeleton');
		skeleton.setAttribute('aria-label', 'Loading tasks');
		for (let i = 0; i < 5; i++) {
			const row = skeleton.createDiv('omi-skeleton-row');
			row.createDiv('omi-skeleton-checkbox');
			row.createDiv('omi-skeleton-text');
			row.createDiv('omi-skeleton-date');
		}
	}

	private renderEmptyState(container: HTMLElement, context: string): void {
		const empty = container.createDiv('omi-tasks-empty-state');

		if (context === 'all') {
			empty.createEl('div', { text: '🎯', cls: 'omi-empty-icon' });
			empty.createEl('h3', { text: 'No tasks yet' });
			empty.createEl('p', { text: 'Click "+ Add Task" to create your first task' });
		} else if (context === 'today') {
			empty.createEl('div', { text: '🎉', cls: 'omi-empty-icon' });
			empty.createEl('p', { text: 'Nothing due today!' });
		} else if (context === 'tomorrow') {
			empty.createEl('div', { text: '📆', cls: 'omi-empty-icon' });
			empty.createEl('p', { text: 'Nothing due tomorrow' });
		} else if (context === 'noDeadline') {
			empty.createEl('div', { text: '📋', cls: 'omi-empty-icon' });
			empty.createEl('p', { text: 'No unscheduled tasks' });
		} else if (context === 'later') {
			empty.createEl('div', { text: '🗓️', cls: 'omi-empty-icon' });
			empty.createEl('p', { text: 'No upcoming tasks' });
		} else if (context === 'completed') {
			empty.createEl('div', { text: '✅', cls: 'omi-empty-icon' });
			empty.createEl('p', { text: 'No completed tasks yet' });
		} else if (context === 'search') {
			empty.createEl('div', { text: '🔍', cls: 'omi-empty-icon' });
			empty.createEl('p', { text: 'No tasks match your search' });
		}
	}

	// Parse date string to local date (handles timezone correctly)
	private parseDateToLocal(dateStr: string): Date {
		// Extract just the date part (YYYY-MM-DD)
		const datePart = dateStr.split('T')[0];
		const [year, month, day] = datePart.split('-').map(Number);
		// Create date in local timezone (months are 0-indexed)
		return new Date(year, month - 1, day, 0, 0, 0, 0);
	}

	private isOverdue(dueAt: string | null): boolean {
		if (!dueAt) return false;
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const dueDate = this.parseDateToLocal(dueAt);
		return dueDate < today;
	}

	private isToday(dueAt: string | null): boolean {
		if (!dueAt) return false;
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const dueDate = this.parseDateToLocal(dueAt);
		return dueDate.getTime() === today.getTime();
	}

	private isTomorrow(dueAt: string | null): boolean {
		if (!dueAt) return false;
		const tomorrow = new Date();
		tomorrow.setHours(0, 0, 0, 0);
		tomorrow.setDate(tomorrow.getDate() + 1);
		const dueDate = this.parseDateToLocal(dueAt);
		return dueDate.getTime() === tomorrow.getTime();
	}

	private groupTasksByTimeframe(tasks: TaskWithUI[]): {
		today: TaskWithUI[];
		tomorrow: TaskWithUI[];
		noDeadline: TaskWithUI[];
		later: TaskWithUI[];
	} {
		const result = {
			today: [] as TaskWithUI[],
			tomorrow: [] as TaskWithUI[],
			noDeadline: [] as TaskWithUI[],
			later: [] as TaskWithUI[]
		};

		for (const task of tasks) {
			if (!task.dueAt) {
				result.noDeadline.push(task);
			} else if (this.isOverdue(task.dueAt)) {
				// Overdue tasks go into Today section
				result.today.push(task);
			} else if (this.isToday(task.dueAt)) {
				result.today.push(task);
			} else if (this.isTomorrow(task.dueAt)) {
				result.tomorrow.push(task);
			} else {
				result.later.push(task);
			}
		}

		// Sort "later" by date ascending
		result.later.sort((a, b) => {
			const dateA = new Date(a.dueAt!).getTime();
			const dateB = new Date(b.dueAt!).getTime();
			return dateA - dateB;
		});

		return result;
	}

	private renderViewModeTabs(container: HTMLElement): void {
		const tabs = container.createDiv('omi-tasks-view-tabs');
		tabs.setAttribute('role', 'tablist');
		tabs.setAttribute('aria-label', 'Task view modes');

		const modes: Array<{ id: 'list' | 'kanban' | 'calendar'; label: string }> = [
			{ id: 'list', label: '☰ List' },
			{ id: 'kanban', label: '⧉ Kanban' },
			{ id: 'calendar', label: '📅 Calendar' }
		];

		for (const mode of modes) {
			const tab = tabs.createEl('button', {
				text: mode.label,
				cls: `omi-view-tab ${this.viewMode === mode.id ? 'active' : ''}`
			});
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', String(this.viewMode === mode.id));
			tab.setAttribute('aria-label', `${mode.label} view`);
			tab.addEventListener('click', async () => {
				this.viewMode = mode.id;
				// Save preference
				this.plugin.settings.tasksViewMode = mode.id;
				await this.plugin.saveSettings();
				this.render();
			});
		}
	}

	private renderListView(container: HTMLElement): void {
		// Filter tasks
		const filtered = this.getFilteredTasks();
		const pending = filtered.filter(t => !t.completed);
		const completed = filtered.filter(t => t.completed);

		// Group pending tasks by timeframe
		const grouped = this.groupTasksByTimeframe(pending);

		// Render sections in order: Today → Tomorrow → No Deadline → Later → Completed
		this.renderSection(container, 'Today', grouped.today, 'today', '🌅');
		this.renderSection(container, 'Tomorrow', grouped.tomorrow, 'tomorrow', '📆');
		this.renderSection(container, 'No Deadline', grouped.noDeadline, 'noDeadline', '📋');
		this.renderSection(container, 'Later', grouped.later, 'later', '🗓️');
		this.renderSection(container, 'Completed', completed, 'completed', '✅');
	}

	private getFilteredTasks(): TaskWithUI[] {
		return this.tasks.filter(t =>
			t.description.toLowerCase().includes(this.searchQuery.toLowerCase())
		);
	}

	// ==================== KANBAN VIEW ====================

	private renderKanbanView(container: HTMLElement): void {
		// Layout toggle (Status vs Date)
		const layoutToggle = container.createDiv('omi-kanban-layout-toggle');
		const statusBtn = layoutToggle.createEl('button', {
			text: '⏳ Status',
			cls: `omi-layout-toggle-btn ${this.kanbanLayout === 'status' ? 'active' : ''}`
		});
		const dateBtn = layoutToggle.createEl('button', {
			text: '📅 Date',
			cls: `omi-layout-toggle-btn ${this.kanbanLayout === 'date' ? 'active' : ''}`
		});

		statusBtn.addEventListener('click', async () => {
			this.kanbanLayout = 'status';
			this.plugin.settings.tasksKanbanLayout = 'status';
			await this.plugin.saveSettings();
			this.render();
		});
		dateBtn.addEventListener('click', async () => {
			this.kanbanLayout = 'date';
			this.plugin.settings.tasksKanbanLayout = 'date';
			await this.plugin.saveSettings();
			this.render();
		});

		const board = container.createDiv('omi-kanban-board');
		const filtered = this.getFilteredTasks();

		// Only show pending tasks by default in Kanban
		const pendingTasks = filtered.filter(t => !t.completed);

		if (this.kanbanLayout === 'status') {
			this.renderKanbanColumn(board, '⏳ Pending', pendingTasks, 'pending');
			this.renderKanbanColumn(board, '✅ Completed', filtered.filter(t => t.completed), 'completed');
		} else {
			// Date-based layout: Today, Tomorrow, No Deadline, Later
			const grouped = this.groupTasksByDateColumn(pendingTasks);
			this.renderKanbanColumn(board, '🌅 Today', grouped.today, 'today');
			this.renderKanbanColumn(board, '📆 Tomorrow', grouped.tomorrow, 'tomorrow');
			this.renderKanbanColumn(board, '📋 No Deadline', grouped.noDeadline, 'noDeadline');
			this.renderKanbanColumn(board, '🗓️ Later', grouped.later, 'later');
		}
	}

	private renderKanbanColumn(board: HTMLElement, title: string, tasks: TaskWithUI[], columnId: string): void {
		const column = board.createDiv('omi-kanban-column');
		column.dataset.columnId = columnId;

		const header = column.createDiv('omi-kanban-column-header');
		header.createEl('span', { text: `${title} (${tasks.length})` });

		const taskList = column.createDiv('omi-kanban-task-list');

		// Setup as drop target
		taskList.addEventListener('dragover', (e) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
			taskList.classList.add('drag-over');
		});
		taskList.addEventListener('dragleave', () => {
			taskList.classList.remove('drag-over');
		});
		taskList.addEventListener('drop', (e) => {
			e.preventDefault();
			taskList.classList.remove('drag-over');
			this.handleKanbanDrop(columnId);
		});

		for (const task of tasks) {
			this.renderKanbanCard(taskList, task);
		}

		if (tasks.length === 0) {
			taskList.createEl('div', { text: 'No tasks', cls: 'omi-kanban-empty' });
		}
	}

	private renderKanbanCard(container: HTMLElement, task: TaskWithUI): void {
		const isOverdueTask = task.dueAt && this.isOverdue(task.dueAt) && !task.completed;
		const cardClasses = ['omi-kanban-card'];
		if (isOverdueTask) cardClasses.push('overdue');
		if (task.completed) cardClasses.push('completed');

		const card = container.createDiv(cardClasses.join(' '));
		card.draggable = true;
		card.dataset.taskId = task.id || '';
		card.setAttribute('role', 'article');
		card.setAttribute('aria-label', `Task: ${task.description}${task.completed ? ' (completed)' : ''}${isOverdueTask ? ' (overdue)' : ''}`);
		card.setAttribute('tabindex', '0');

		// Setup drag events
		card.addEventListener('dragstart', (e) => {
			this.draggedTask = task;
			card.classList.add('dragging');
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', task.id || '');
			}
		});
		card.addEventListener('dragend', () => {
			this.draggedTask = null;
			card.classList.remove('dragging');
			document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
		});

		// Status dot (TaskNotes inspired)
		let statusClass = 'omi-task__status--pending';
		if (task.completed) {
			statusClass = 'omi-task__status--completed';
		} else if (isOverdueTask) {
			statusClass = 'omi-task__status--overdue';
		}
		const statusDot = card.createDiv(`omi-task__status ${statusClass}`);
		statusDot.setAttribute('aria-hidden', 'true');

		// Checkbox
		const checkbox = card.createEl('input', { type: 'checkbox' });
		checkbox.checked = task.completed;
		checkbox.setAttribute('aria-label', `Mark as ${task.completed ? 'pending' : 'completed'}`);
		checkbox.addEventListener('click', (e) => e.stopPropagation());
		checkbox.addEventListener('change', () => this.toggleTaskCompletion(task));

		// Content wrapper
		const content = card.createDiv('omi-kanban-card-content');

		// Description (clickable to edit)
		const desc = content.createEl('div', { text: task.description, cls: 'omi-kanban-card-desc' });

		// Due date subtitle (contextual)
		if (task.dueAt) {
			const dateSubtitle = content.createEl('span', { cls: 'omi-kanban-card-date' });
			if (isOverdueTask) {
				dateSubtitle.textContent = `Overdue: ${this.formatCompactDate(task.dueAt)}`;
				dateSubtitle.classList.add('overdue');
			} else {
				dateSubtitle.textContent = this.formatCompactDate(task.dueAt);
			}
		}

		// Click on card to edit (but not on checkbox)
		card.addEventListener('click', (e) => {
			// Don't open edit if clicking checkbox
			if ((e.target as HTMLElement).tagName === 'INPUT') return;
			this.openEditTaskModal(task);
		});

		// Keyboard support
		card.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.openEditTaskModal(task);
			}
		});
	}

	private openEditTaskModal(task: TaskWithUI): void {
		const modal = new EditTaskModal(
			this.app,
			task,
			async (updates) => {
				if (!task.id) return;
				try {
					const updateData: { description?: string; due_at?: string | null } = {};
					if (updates.description !== undefined && updates.description !== task.description) {
						updateData.description = updates.description;
					}
					if (updates.dueAt !== undefined && updates.dueAt !== task.dueAt) {
						updateData.due_at = updates.dueAt ? this.localToUTC(updates.dueAt) : null;
					}
					if (Object.keys(updateData).length > 0) {
						await this.plugin.api.updateActionItem(task.id, updateData);
						if (updates.description !== undefined) task.description = updates.description;
						if (updates.dueAt !== undefined) task.dueAt = updates.dueAt;
						this.render();
						this.requestBackupSync();
					}
				} catch (error) {
					console.error('Error updating task:', error);
					new Notice('Failed to update task');
				}
			},
			async () => {
				// onDelete callback
				await this.deleteTask(task);
			}
		);
		modal.open();
	}

	private async handleKanbanDrop(columnId: string): Promise<void> {
		const task = this.draggedTask;
		if (!task?.id) return;

		try {
			if (this.kanbanLayout === 'status') {
				// Status-based: update completed status
				const newCompleted = columnId === 'completed';
				if (task.completed !== newCompleted) {
					await this.plugin.api.updateActionItem(task.id, { completed: newCompleted });
					task.completed = newCompleted;
					this.render();
					this.requestBackupSync();
				}
			} else {
				// Date-based: update due date
				const newDueAt = this.getDateForColumn(columnId);
				const utcDate = this.localToUTC(newDueAt);
				await this.plugin.api.updateActionItem(task.id, { due_at: utcDate });
				task.dueAt = newDueAt;
				this.render();
				this.requestBackupSync();
			}
		} catch (error) {
			console.error('Error updating task via drag:', error);
			new Notice('Failed to update task');
		}
	}

	// Kanban now uses the same grouping as list view (Today, Tomorrow, No Deadline, Later)
	// This method is kept for backward compatibility but now just wraps groupTasksByTimeframe
	private groupTasksByDateColumn(tasks: TaskWithUI[]): {
		today: TaskWithUI[];
		tomorrow: TaskWithUI[];
		noDeadline: TaskWithUI[];
		later: TaskWithUI[];
	} {
		return this.groupTasksByTimeframe(tasks);
	}

	private getDateForColumn(columnId: string): string | null {
		const now = new Date();
		switch (columnId) {
			case 'today':
				return this.formatDateOnly(now);
			case 'tomorrow':
				now.setDate(now.getDate() + 1);
				return this.formatDateOnly(now);
			case 'later':
				now.setDate(now.getDate() + 7);
				return this.formatDateOnly(now);
			case 'noDeadline':
				return null;
			default:
				return null;
		}
	}

	private formatDateOnly(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	private formatCompactDate(dateStr: string): string {
		const date = this.parseDateToLocal(dateStr);
		return date.toLocaleDateString('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric'
		});
	}

	private formatTimeOnly(dateStr: string): string {
		if (!dateStr.includes('T')) return '';
		const date = new Date(dateStr);
		return date.toLocaleTimeString('en-US', {
			hour: 'numeric',
			minute: '2-digit',
			hour12: true
		});
	}

	private setupSourceTooltip(element: HTMLElement, sourceLink: string): void {
		// Parse conversation ID from sourceLink (format: "conversation:{id}")
		const convId = sourceLink.replace('conversation:', '');
		const conv = this.plugin.settings.syncedConversations[convId];

		if (!conv) {
			element.title = 'From conversation (not synced)';
			return;
		}

		// Create tooltip element
		let tooltip: HTMLElement | null = null;

		const showTooltip = () => {
			if (tooltip) return;

			tooltip = document.createElement('div');
			tooltip.className = 'omi-task-source-tooltip';

			// Header with emoji and title
			const header = tooltip.createDiv('omi-tooltip-header');
			header.createEl('span', { text: conv.emoji || '💬', cls: 'omi-tooltip-emoji' });
			header.createEl('span', { text: conv.title || 'Untitled', cls: 'omi-tooltip-title' });

			// Meta info
			const meta = tooltip.createDiv('omi-tooltip-meta');
			const dateStr = new Date(conv.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
			meta.textContent = `${dateStr} • ${conv.duration || 0} min`;

			// Overview snippet
			if (conv.overview) {
				const overview = tooltip.createDiv('omi-tooltip-overview');
				overview.textContent = `"${conv.overview.substring(0, 100)}${conv.overview.length > 100 ? '...' : ''}"`;
			}

			// Click hint
			const hint = tooltip.createDiv('omi-tooltip-hint');
			hint.textContent = 'Click to view conversation';

			// Position tooltip
			document.body.appendChild(tooltip);
			const rect = element.getBoundingClientRect();
			tooltip.style.top = `${rect.bottom + 8}px`;
			tooltip.style.left = `${rect.left - 100}px`;

			// Adjust if off-screen
			const tooltipRect = tooltip.getBoundingClientRect();
			if (tooltipRect.right > window.innerWidth - 10) {
				tooltip.style.left = `${window.innerWidth - tooltipRect.width - 10}px`;
			}
			if (tooltipRect.left < 10) {
				tooltip.style.left = '10px';
			}
		};

		const hideTooltip = () => {
			if (tooltip) {
				tooltip.remove();
				tooltip = null;
			}
		};

		element.addEventListener('mouseenter', showTooltip);
		element.addEventListener('mouseleave', hideTooltip);

		// Click to navigate to conversation
		element.style.cursor = 'pointer';
		element.addEventListener('click', async (e) => {
			e.stopPropagation();
			hideTooltip();

			// Switch to conversations tab and select this conversation
			this.activeTab = 'conversations';
			this.plugin.settings.activeHubTab = 'conversations';
			this.selectedConversationId = convId;
			this.detailTab = 'summary';
			await this.loadConversationDetails(convId);
			await this.plugin.saveSettings();
			this.render();
		});
	}

	// ==================== DAILY VIEW HELPERS ====================

	private getSortedUniqueDates(): string[] {
		const conversations = this.plugin.settings.syncedConversations || {};
		const dates = new Set<string>();
		for (const conv of Object.values(conversations)) {
			dates.add((conv as SyncedConversationMeta).date);
		}
		return Array.from(dates).sort((a, b) => b.localeCompare(a)); // Newest first
	}

	private getConversationsForDate(dateStr: string): SyncedConversationMeta[] {
		const conversations = this.plugin.settings.syncedConversations || {};
		const result: SyncedConversationMeta[] = [];
		for (const conv of Object.values(conversations)) {
			if ((conv as SyncedConversationMeta).date === dateStr) {
				result.push(conv as SyncedConversationMeta);
			}
		}
		// Sort by time descending (latest first)
		return result.sort((a, b) => this.compareTime(b.time, a.time));
	}

	// ==================== CALENDAR VIEW ====================

	private renderCalendarView(container: HTMLElement): void {
		// Controls row (view type + show completed toggle)
		const controls = container.createDiv('omi-calendar-controls');

		// View type toggle (Monthly vs Weekly)
		const viewToggle = controls.createDiv('omi-calendar-view-toggle');
		const monthlyBtn = viewToggle.createEl('button', {
			text: 'Monthly',
			cls: `omi-calendar-toggle-btn ${this.calendarViewType === 'monthly' ? 'active' : ''}`
		});
		const weeklyBtn = viewToggle.createEl('button', {
			text: 'Weekly',
			cls: `omi-calendar-toggle-btn ${this.calendarViewType === 'weekly' ? 'active' : ''}`
		});

		monthlyBtn.addEventListener('click', async () => {
			this.calendarViewType = 'monthly';
			this.plugin.settings.tasksCalendarType = 'monthly';
			await this.plugin.saveSettings();
			this.render();
		});
		weeklyBtn.addEventListener('click', async () => {
			this.calendarViewType = 'weekly';
			this.plugin.settings.tasksCalendarType = 'weekly';
			await this.plugin.saveSettings();
			this.render();
		});

		// Show completed toggle
		const completedToggle = controls.createDiv('omi-calendar-completed-toggle');
		const completedCheckbox = completedToggle.createEl('input', { type: 'checkbox' });
		completedCheckbox.checked = this.calendarShowCompleted;
		completedCheckbox.id = 'calendar-show-completed';
		const completedLabel = completedToggle.createEl('label', { text: 'Show completed' });
		completedLabel.setAttribute('for', 'calendar-show-completed');
		completedCheckbox.addEventListener('change', () => {
			this.calendarShowCompleted = completedCheckbox.checked;
			this.render();
		});

		// Navigation
		this.renderCalendarNavigation(container);

		// Calendar grid
		if (this.calendarViewType === 'monthly') {
			this.renderMonthlyCalendar(container);
		} else {
			this.renderWeeklyCalendar(container);
		}
	}

	private renderCalendarNavigation(container: HTMLElement): void {
		const nav = container.createDiv('omi-calendar-nav');

		const prevBtn = nav.createEl('button', { text: '◀', cls: 'omi-calendar-nav-btn' });
		prevBtn.addEventListener('click', () => {
			if (this.calendarViewType === 'monthly') {
				this.calendarCurrentDate.setMonth(this.calendarCurrentDate.getMonth() - 1);
			} else {
				this.calendarCurrentDate.setDate(this.calendarCurrentDate.getDate() - 7);
			}
			this.render();
		});

		const label = nav.createEl('span', {
			text: this.calendarViewType === 'monthly'
				? this.calendarCurrentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
				: `Week of ${this.getWeekStartDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
			cls: 'omi-calendar-nav-label'
		});

		const nextBtn = nav.createEl('button', { text: '▶', cls: 'omi-calendar-nav-btn' });
		nextBtn.addEventListener('click', () => {
			if (this.calendarViewType === 'monthly') {
				this.calendarCurrentDate.setMonth(this.calendarCurrentDate.getMonth() + 1);
			} else {
				this.calendarCurrentDate.setDate(this.calendarCurrentDate.getDate() + 7);
			}
			this.render();
		});

		const todayBtn = nav.createEl('button', { text: 'Today', cls: 'omi-calendar-today-btn' });
		todayBtn.addEventListener('click', () => {
			this.calendarCurrentDate = new Date();
			this.render();
		});
	}

	private renderMonthlyCalendar(container: HTMLElement): void {
		const calendar = container.createDiv('omi-calendar-grid-monthly');

		// Day headers
		const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		const headerRow = calendar.createDiv('omi-calendar-header-row');
		for (const day of dayNames) {
			headerRow.createEl('div', { text: day, cls: 'omi-calendar-day-header' });
		}

		// Get days for the grid
		const days = this.getMonthGridDays();
		const gridBody = calendar.createDiv('omi-calendar-body');

		for (const day of days) {
			const dayCell = gridBody.createDiv('omi-calendar-day-cell');
			if (!day.isCurrentMonth) dayCell.addClass('other-month');
			if (day.isToday) dayCell.addClass('today');

			dayCell.createEl('div', { text: String(day.date.getDate()), cls: 'omi-calendar-day-number' });

			// Get tasks for this day
			const dayTasks = this.getTasksForDate(day.date);
			const taskContainer = dayCell.createDiv('omi-calendar-day-tasks');

			// Show up to 3 tasks
			const maxVisible = 3;
			for (let i = 0; i < Math.min(dayTasks.length, maxVisible); i++) {
				const taskPill = taskContainer.createEl('div', {
					text: dayTasks[i].description.substring(0, 15) + (dayTasks[i].description.length > 15 ? '...' : ''),
					cls: `omi-calendar-task-pill ${dayTasks[i].completed ? 'completed' : ''}`
				});
				taskPill.addEventListener('click', (e) => {
					e.stopPropagation();
					this.showEditTaskModal(dayTasks[i]);
				});
			}

			if (dayTasks.length > maxVisible) {
				taskContainer.createEl('div', {
					text: `+${dayTasks.length - maxVisible} more`,
					cls: 'omi-calendar-more-tasks'
				});
			}

			// Click on day to add task with that date
			dayCell.addEventListener('click', () => this.showAddTaskDialogWithDate(day.date));
		}
	}

	private renderWeeklyCalendar(container: HTMLElement): void {
		const calendar = container.createDiv('omi-calendar-grid-weekly');
		const weekStart = this.getWeekStartDate();

		for (let i = 0; i < 7; i++) {
			const day = new Date(weekStart);
			day.setDate(weekStart.getDate() + i);

			const dayColumn = calendar.createDiv('omi-calendar-week-day');
			const isToday = this.isSameDay(day, new Date());
			if (isToday) dayColumn.addClass('today');

			// Day header
			const dayHeader = dayColumn.createDiv('omi-calendar-week-day-header');
			dayHeader.createEl('span', { text: day.toLocaleDateString('en-US', { weekday: 'short' }) });
			dayHeader.createEl('span', { text: String(day.getDate()), cls: 'omi-calendar-week-day-num' });

			// Tasks for this day
			const dayTasks = this.getTasksForDate(day);
			const taskList = dayColumn.createDiv('omi-calendar-week-day-tasks');

			for (const task of dayTasks) {
				const taskRow = taskList.createDiv('omi-calendar-week-task');

				const checkbox = taskRow.createEl('input', { type: 'checkbox' });
				checkbox.checked = task.completed;
				checkbox.addEventListener('change', () => this.toggleTaskCompletion(task));

				const desc = taskRow.createEl('span', {
					text: task.description.substring(0, 25) + (task.description.length > 25 ? '...' : ''),
					cls: task.completed ? 'completed' : ''
				});
				desc.addEventListener('click', () => this.showEditTaskModal(task));
			}

			// Add task button for this day
			const addBtn = dayColumn.createEl('button', { text: '+', cls: 'omi-calendar-add-task' });
			addBtn.addEventListener('click', () => this.showAddTaskDialogWithDate(day));
		}
	}

	private getMonthGridDays(): Array<{ date: Date; isCurrentMonth: boolean; isToday: boolean }> {
		const year = this.calendarCurrentDate.getFullYear();
		const month = this.calendarCurrentDate.getMonth();

		// First day of the month
		const firstDay = new Date(year, month, 1);
		// Last day of the month
		const lastDay = new Date(year, month + 1, 0);

		const days: Array<{ date: Date; isCurrentMonth: boolean; isToday: boolean }> = [];
		const today = new Date();

		// Days from previous month to fill first week
		const firstDayOfWeek = firstDay.getDay();
		for (let i = firstDayOfWeek - 1; i >= 0; i--) {
			const date = new Date(year, month, -i);
			days.push({ date, isCurrentMonth: false, isToday: this.isSameDay(date, today) });
		}

		// Days of current month
		for (let d = 1; d <= lastDay.getDate(); d++) {
			const date = new Date(year, month, d);
			days.push({ date, isCurrentMonth: true, isToday: this.isSameDay(date, today) });
		}

		// Days from next month to fill last week
		const remainingDays = 42 - days.length; // 6 rows × 7 days
		for (let i = 1; i <= remainingDays; i++) {
			const date = new Date(year, month + 1, i);
			days.push({ date, isCurrentMonth: false, isToday: this.isSameDay(date, today) });
		}

		return days;
	}

	private getTasksForDate(date: Date): TaskWithUI[] {
		return this.getFilteredTasks().filter(task => {
			// Filter out completed tasks if toggle is off
			if (!this.calendarShowCompleted && task.completed) return false;
			if (!task.dueAt) return false;
			// Use timezone-aware date parsing
			const taskDate = this.parseDateToLocal(task.dueAt);
			return this.isSameDay(taskDate, date);
		});
	}

	private isSameDay(d1: Date, d2: Date): boolean {
		return d1.getFullYear() === d2.getFullYear()
			&& d1.getMonth() === d2.getMonth()
			&& d1.getDate() === d2.getDate();
	}

	private showAddTaskDialogWithDate(date: Date): void {
		const modal = new AddTaskModal(this.app, async (description: string, dueDate?: string) => {
			// Use the pre-selected date if no date was entered in modal
			const finalDueDate = dueDate || this.formatDateOnly(date);
			await this.addNewTask(description, finalDueDate);
		});
		modal.open();
	}

	private renderSection(container: HTMLElement, title: string, tasks: TaskWithUI[], sectionId: string, emoji: string): void {
		const section = container.createDiv(`omi-tasks-section omi-tasks-${sectionId}`);

		const isCollapsed = this.sectionCollapsed[sectionId] ?? false;

		const sectionHeader = section.createDiv('omi-tasks-section-header');
		sectionHeader.setAttribute('role', 'button');
		sectionHeader.setAttribute('aria-expanded', String(!isCollapsed));
		sectionHeader.setAttribute('aria-controls', `section-${sectionId}`);
		sectionHeader.setAttribute('tabindex', '0');

		const collapseBtn = sectionHeader.createEl('span', {
			text: isCollapsed ? '▶' : '▼',
			cls: 'omi-tasks-collapse-btn'
		});
		collapseBtn.setAttribute('aria-hidden', 'true');
		sectionHeader.createEl('span', { text: ` ${emoji} ${title} (${tasks.length})` });

		const toggleSection = () => {
			this.sectionCollapsed[sectionId] = !this.sectionCollapsed[sectionId];
			this.render();
		};

		sectionHeader.addEventListener('click', toggleSection);
		sectionHeader.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggleSection();
			}
		});

		if (!isCollapsed) {
			const taskList = section.createDiv('omi-tasks-list');
			taskList.setAttribute('id', `section-${sectionId}`);
			taskList.setAttribute('role', 'list');

			for (const task of tasks) {
				this.renderTaskRow(taskList, task, sectionId);
			}

			if (tasks.length === 0) {
				this.renderEmptyState(taskList, sectionId);
			}
		}
	}

	private renderTaskRow(container: HTMLElement, task: TaskWithUI, sectionId: string = 'pending'): void {
		const rowClasses = ['omi-task-row'];
		if (task.completed) rowClasses.push('completed');
		const row = container.createDiv(rowClasses.join(' '));
		row.setAttribute('role', 'listitem');
		row.setAttribute('tabindex', '0');

		// Check if task is overdue (for date display)
		const isOverdueTask = task.dueAt && this.isOverdue(task.dueAt) && !task.completed;

		// Checkbox
		const checkbox = row.createEl('input', { type: 'checkbox' });
		checkbox.checked = task.completed;
		checkbox.setAttribute('aria-label', `Mark "${task.description}" as ${task.completed ? 'pending' : 'completed'}`);
		checkbox.addEventListener('change', async () => {
			// Add completing animation
			row.classList.add('completing');
			await this.toggleTaskCompletion(task);
		});

		// Content wrapper (description + date subtitle)
		const contentWrapper = row.createDiv('omi-task-content');

		// Description (editable)
		const descEl = contentWrapper.createEl('span', {
			text: task.description,
			cls: 'omi-task-description'
		});
		descEl.contentEditable = 'true';
		descEl.setAttribute('role', 'textbox');
		descEl.setAttribute('aria-label', 'Task description, click to edit');
		descEl.addEventListener('blur', async (e) => {
			const newDesc = (e.target as HTMLElement).textContent?.trim() || '';
			if (newDesc !== task.description && newDesc.length >= 3) {
				await this.updateTaskDescription(task, newDesc);
			} else if (newDesc !== task.description) {
				// Revert to original if too short
				descEl.textContent = task.description;
			}
		});
		descEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				descEl.blur();
			}
			if (e.key === 'Escape') {
				descEl.textContent = task.description;
				descEl.blur();
			}
		});

		// Date subtitle (contextual based on section)
		const dateSubtitle = contentWrapper.createEl('span', { cls: 'omi-task-date-subtitle' });
		dateSubtitle.addEventListener('click', (e) => {
			e.stopPropagation();
			this.showDatePicker(task);
		});

		if (task.dueAt) {
			// Format date based on section context
			if (sectionId === 'today' || sectionId === 'tomorrow') {
				// Show time only if set, otherwise show "All day" or overdue indicator
				const hasTime = task.dueAt.includes('T') && !task.dueAt.endsWith('T00:00:00');
				if (isOverdueTask) {
					dateSubtitle.textContent = `Overdue: ${this.formatCompactDate(task.dueAt)}`;
					dateSubtitle.classList.add('overdue');
				} else if (hasTime) {
					dateSubtitle.textContent = this.formatTimeOnly(task.dueAt);
				} else {
					dateSubtitle.textContent = 'All day';
				}
			} else if (sectionId === 'later') {
				// Show compact date like "Wed, Dec 25"
				dateSubtitle.textContent = this.formatCompactDate(task.dueAt);
			} else if (sectionId === 'completed') {
				// Show full date for completed tasks
				dateSubtitle.textContent = this.formatCompactDate(task.dueAt);
			}
			dateSubtitle.setAttribute('aria-label', `Due: ${task.dueAt}. Click to change`);
		} else {
			// No deadline - show add date link
			dateSubtitle.textContent = '+ Add date';
			dateSubtitle.classList.add('add-date');
			dateSubtitle.setAttribute('aria-label', 'Add due date');
		}

		// Source indicator (if from conversation)
		if (task.sourceLink) {
			const sourceEl = row.createEl('span', { text: '💬', cls: 'omi-task-source' });
			sourceEl.setAttribute('aria-label', 'Task from conversation');
			this.setupSourceTooltip(sourceEl, task.sourceLink);
		}

		// Delete button
		const deleteBtn = row.createEl('span', { text: '🗑️', cls: 'omi-task-delete' });
		deleteBtn.setAttribute('aria-label', `Delete task: ${task.description}`);
		deleteBtn.setAttribute('role', 'button');
		deleteBtn.setAttribute('tabindex', '0');
		const handleDelete = async () => {
			if (confirm(`Delete task: "${task.description}"?`)) {
				await this.deleteTask(task);
			}
		};
		deleteBtn.addEventListener('click', handleDelete);
		deleteBtn.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				handleDelete();
			}
		});
	}

	private async toggleTaskCompletion(task: TaskWithUI): Promise<void> {
		if (!task.id) return;
		const newCompleted = !task.completed;
		try {
			await this.plugin.api.updateActionItem(task.id, { completed: newCompleted });
			task.completed = newCompleted;
			this.render();  // Just re-render, no file operations
			this.requestBackupSync();
		} catch (error) {
			console.error('Error updating task:', error);
			new Notice('Failed to update task');
		}
	}

	private async updateTaskDescription(task: TaskWithUI, newDescription: string): Promise<void> {
		if (!task.id) return;
		try {
			await this.plugin.api.updateActionItem(task.id, { description: newDescription });
			task.description = newDescription;
			this.render();
			this.requestBackupSync();
		} catch (error) {
			console.error('Error updating task:', error);
			new Notice('Failed to update task');
		}
	}

	private async deleteTask(task: TaskWithUI): Promise<void> {
		if (!task.id) return;
		try {
			await this.plugin.api.deleteActionItem(task.id);
			this.tasks = this.tasks.filter(t => t.id !== task.id);
			this.render();
			this.requestBackupSync();
		} catch (error) {
			console.error('Error deleting task:', error);
			new Notice('Failed to delete task');
		}
	}

	private showAddTaskDialog(): void {
		const modal = new AddTaskModal(this.app, async (description: string, dueDate?: string) => {
			await this.addNewTask(description, dueDate);
		});
		modal.open();
	}

	private async addNewTask(description: string, dueDateTime?: string): Promise<void> {
		try {
			// Convert local datetime to UTC before sending to API
			const utcDueDateTime = dueDateTime ? this.localToUTC(dueDateTime) ?? undefined : undefined;
			const created = await this.plugin.api.createActionItem(description, utcDueDateTime);
			// Add to local list immediately
			this.tasks.unshift({
				id: created.id,
				description: created.description,
				completed: created.completed,
				dueAt: created.due_at ? this.parseDueAt(created.due_at) : null,
				sourceLink: null,
				lineIndex: -1,
				isEditing: false
			});
			this.render();
			new Notice('Task created');
			this.requestBackupSync();
		} catch (error) {
			console.error('Error creating task:', error);
			new Notice('Failed to create task');
		}
	}

	private showDatePicker(task: TaskWithUI): void {
		const modal = new DatePickerModal(this.app, task.dueAt, async (newDate: string | null) => {
			if (!task.id) return;
			try {
				// Convert local datetime to UTC before sending to API
				const utcDate = this.localToUTC(newDate);
				await this.plugin.api.updateActionItem(task.id, { due_at: utcDate });
				task.dueAt = newDate;  // Store local time for display
				this.render();
				this.requestBackupSync();
			} catch (error) {
				console.error('Error updating due date:', error);
				new Notice('Failed to update due date');
			}
		});
		modal.open();
	}

	private showEditTaskModal(task: TaskWithUI): void {
		const modal = new EditTaskModal(
			this.app,
			task,
			async (updates) => {
				if (!task.id) return;
				try {
					const apiUpdates: { description?: string; due_at?: string | null } = {};

					if (updates.description !== undefined && updates.description !== task.description) {
						apiUpdates.description = updates.description;
					}

					if (updates.dueAt !== undefined) {
						// Convert local datetime to UTC before sending to API
						apiUpdates.due_at = this.localToUTC(updates.dueAt);
					}

					if (Object.keys(apiUpdates).length > 0) {
						await this.plugin.api.updateActionItem(task.id, apiUpdates);
						if (updates.description !== undefined) {
							task.description = updates.description;
						}
						if (updates.dueAt !== undefined) {
							task.dueAt = updates.dueAt;
						}
						this.render();
						new Notice('Task updated');
						this.requestBackupSync();
					}
				} catch (error) {
					console.error('Error updating task:', error);
					new Notice('Failed to update task');
				}
			},
			async () => {
				if (!task.id) return;
				try {
					await this.plugin.api.deleteActionItem(task.id);
					this.tasks = this.tasks.filter(t => t.id !== task.id);
					this.render();
					new Notice('Task deleted');
					this.requestBackupSync();
				} catch (error) {
					console.error('Error deleting task:', error);
					new Notice('Failed to delete task');
				}
			}
		);
		modal.open();
	}
}