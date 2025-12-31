import { ItemView, WorkspaceLeaf, Notice, debounce, setIcon } from 'obsidian';
import { VIEW_TYPE_OMI_HUB, MEMORY_CATEGORY_EMOJI } from './constants';
import { TaskWithUI, SyncedConversationMeta, ConversationDetailData, ActionItem, CalendarEvent, TranscriptSegment, MemoryWithUI, StatsData, HeatmapCell, CategoryStat, DurationBucket, MemoryStats, TaskStats, Achievement, AchievementData, AchievementCategory, ActionItemFromAPI, MemoryFromAPI } from './types';
import { AddTaskModal, DatePickerModal, EditTaskModal, CalendarDatePickerModal, AddMemoryModal, EditMemoryModal, AchievementsModal } from './modals';
import type OmiConversationsPlugin from './main';

export class OmiHubView extends ItemView {
	plugin: OmiConversationsPlugin;

	// Hub state
	activeTab: 'tasks' | 'conversations' | 'memories' | 'stats' | 'heatmap' | 'map' | 'sync' = 'tasks';

	// Sync progress event unsubscribe function
	private unsubscribeSyncProgress: (() => void) | null = null;

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
	viewMode: 'dashboard' | 'list' | 'kanban' | 'calendar' = 'dashboard';
	calendarViewType: 'monthly' | 'weekly' = 'monthly';
	calendarCurrentDate: Date = new Date();
	calendarShowCompleted = false;  // Hide completed tasks in calendar by default
	private draggedTask: TaskWithUI | null = null;

	// Batch operations state
	isSelectMode = false;
	selectedTaskIds: Set<string> = new Set();

	// Conversations state
	isSyncingConversations = false;
	selectedConversationId: string | null = null;
	detailTab: 'summary' | 'transcript' = 'summary';
	selectedConversationData: ConversationDetailData | null = null;
	isLoadingDetail = false;
	statsTimeRange: 'week' | 'month' | '30days' | 'all' = 'all';
	dailyViewSelectedDate: string | null = null; // YYYY-MM-DD format for unified daily view

	// Stats dashboard state
	private statsData: StatsData | null = null;
	private statsMemories: MemoryFromAPI[] = [];
	private statsTasks: ActionItemFromAPI[] = [];
	private isLoadingStats = false;
	private statsDataLoaded = false;
	// Stats memoization cache
	private statsCacheKey: string | null = null;
	private cachedStatsData: StatsData | null = null;

	// Memories state
	memories: MemoryWithUI[] = [];
	memoriesSearchQuery = '';
	memoriesCategoryFilter: string | null = null;
	memoriesViewMode: 'list' | 'graph' = 'list';
	selectedTagForDetails: string | null = null;  // Currently selected tag to show memories
	isLoadingMemories = false;
	private memoriesAutoRefreshInterval: number | null = null;
	private graphAnimationId: number | null = null;
	private graphCanvas: HTMLCanvasElement | null = null;
	private graphListeners: { event: string; handler: EventListener; options?: AddEventListenerOptions }[] = [];

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
		// Clean up canvas event listeners to prevent memory leaks
		if (this.graphCanvas && this.graphListeners.length > 0) {
			for (const { event, handler, options } of this.graphListeners) {
				this.graphCanvas.removeEventListener(event, handler, options);
			}
			this.graphListeners = [];
			this.graphCanvas = null;
		}
	}

	async loadMemories(showNotice = false): Promise<void> {
		this.isLoadingMemories = true;
		this.render();
		try {
			const items = await this.plugin.api.getAllMemories(this.plugin.settings.memoriesFetchLimit);
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
		} else if (this.activeTab === 'stats') {
			this.renderStatsTab(container);
		} else if (this.activeTab === 'heatmap') {
			this.renderHeatmapTab(container);
		} else if (this.activeTab === 'map') {
			this.renderMapTab(container);
		} else if (this.activeTab === 'sync') {
			this.renderSyncTab(container);
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

		const statsTab = tabs.createEl('button', {
			text: 'Stats',
			cls: `omi-hub-tab ${this.activeTab === 'stats' ? 'active' : ''}`
		});
		statsTab.setAttribute('role', 'tab');
		statsTab.setAttribute('aria-selected', String(this.activeTab === 'stats'));
		statsTab.addEventListener('click', async () => {
			this.activeTab = 'stats';
			this.plugin.settings.activeHubTab = 'stats';
			await this.plugin.saveSettings();
			this.render();
		});

		const heatmapTab = tabs.createEl('button', {
			text: 'Heatmap',
			cls: `omi-hub-tab ${this.activeTab === 'heatmap' ? 'active' : ''}`
		});
		heatmapTab.setAttribute('role', 'tab');
		heatmapTab.setAttribute('aria-selected', String(this.activeTab === 'heatmap'));
		heatmapTab.addEventListener('click', async () => {
			this.activeTab = 'heatmap';
			this.plugin.settings.activeHubTab = 'heatmap';
			await this.plugin.saveSettings();
			this.render();
		});

		const mapTab = tabs.createEl('button', {
			text: 'Map',
			cls: `omi-hub-tab ${this.activeTab === 'map' ? 'active' : ''}`
		});
		mapTab.setAttribute('role', 'tab');
		mapTab.setAttribute('aria-selected', String(this.activeTab === 'map'));
		mapTab.addEventListener('click', async () => {
			this.activeTab = 'map';
			this.plugin.settings.activeHubTab = 'map';
			await this.plugin.saveSettings();
			this.render();
		});

		const syncTab = tabs.createEl('button', {
			text: 'Sync',
			cls: `omi-hub-tab ${this.activeTab === 'sync' ? 'active' : ''}`
		});
		syncTab.setAttribute('role', 'tab');
		syncTab.setAttribute('aria-selected', String(this.activeTab === 'sync'));
		// Show indicator if sync is in progress
		if (this.plugin.syncProgress.isActive) {
			syncTab.createEl('span', { text: '●', cls: 'omi-hub-tab-badge omi-sync-active' });
		}
		syncTab.addEventListener('click', async () => {
			this.activeTab = 'sync';
			this.plugin.settings.activeHubTab = 'sync';
			await this.plugin.saveSettings();
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

		// Select mode toggle (only show in list view with tasks)
		if (this.viewMode === 'list' && this.tasks.length > 0) {
			const selectBtn = toolbar.createEl('button', {
				text: this.isSelectMode ? '✕ Cancel' : '☑ Select',
				cls: `omi-tasks-select-btn ${this.isSelectMode ? 'active' : ''}`
			});
			selectBtn.setAttribute('aria-label', this.isSelectMode ? 'Exit select mode' : 'Enter select mode');
			selectBtn.addEventListener('click', () => {
				this.isSelectMode = !this.isSelectMode;
				if (!this.isSelectMode) {
					this.selectedTaskIds.clear();
				}
				this.render();
			});
		}

		// Progress indicator showing today's completion status
		this.renderProgressIndicator(toolbar);

		// Batch action bar (when in select mode with selections)
		if (this.isSelectMode) {
			this.renderBatchActionBar(tabContent);
		}

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
			case 'dashboard':
				this.renderDashboardView(tabContent);
				break;
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

		// Header: View Mode Tabs + Toolbar
		const header = tabContent.createDiv('omi-memories-header');

		// View Mode Tabs
		this.renderMemoriesViewModeTabs(header);

		// Toolbar: Add button + Sync button
		const toolbar = header.createDiv('omi-memories-toolbar');

		// Only show Add Memory button in list view
		if (this.memoriesViewMode === 'list') {
			const addBtn = toolbar.createEl('button', { text: '+ Add', cls: 'omi-memories-add-btn' });
			addBtn.setAttribute('aria-label', 'Add new memory');
			addBtn.addEventListener('click', () => this.showAddMemoryDialog());
		}

		const syncBtn = toolbar.createEl('button', { text: '🔄', cls: 'omi-memories-sync-btn' });
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

		// For graph view, render full width
		if (this.memoriesViewMode === 'graph') {
			this.renderTagGraph(tabContent);
			return;
		}

		// Split layout: List on left, Insights sidebar on right
		const splitLayout = tabContent.createDiv('omi-memories-split-layout');

		// Main content (list)
		const mainContent = splitLayout.createDiv('omi-memories-main');
		this.renderMemoriesListView(mainContent);

		// Insights sidebar
		const sidebar = splitLayout.createDiv('omi-memories-sidebar');
		this.renderMemoriesInsightsSidebar(sidebar);
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

	// ============================================
	// MEMORIES INSIGHTS SIDEBAR
	// ============================================

	private renderMemoriesInsightsSidebar(container: HTMLElement): void {
		// Header
		container.createEl('h3', { text: '📊 Insights', cls: 'omi-sidebar-title' });

		// Total count with weekly delta
		const totalSection = container.createDiv('omi-sidebar-stat-card');
		const totalCount = totalSection.createDiv('omi-sidebar-stat-number');
		totalCount.setText(this.memories.length.toString());

		const totalLabel = totalSection.createDiv('omi-sidebar-stat-row');
		totalLabel.createEl('span', { text: 'Total Memories', cls: 'omi-sidebar-stat-label' });

		const weeklyDelta = this.getMemoriesWeeklyDelta();
		if (weeklyDelta > 0) {
			const deltaBadge = totalLabel.createEl('span', { cls: 'omi-sidebar-delta-badge positive' });
			deltaBadge.setText(`+${weeklyDelta} this week`);
		}

		// Streak badge
		const streak = this.getMemoryStreak();
		if (streak > 0) {
			const streakBadge = totalSection.createEl('span', { cls: 'omi-sidebar-streak-badge' });
			streakBadge.setText(`🔥 ${streak} day streak`);
		}

		// Activity sparkline (30 days)
		const activitySection = container.createDiv('omi-sidebar-section');
		activitySection.createEl('h4', { text: '📈 Activity (30 days)', cls: 'omi-sidebar-section-title' });
		this.renderMemoriesSparkline(activitySection);

		// Category breakdown
		const categorySection = container.createDiv('omi-sidebar-section');
		categorySection.createEl('h4', { text: '📁 Categories', cls: 'omi-sidebar-section-title' });
		this.renderCategoryBreakdown(categorySection);

		// Top tags
		const tagsSection = container.createDiv('omi-sidebar-section');
		tagsSection.createEl('h4', { text: '🏷️ Top Tags', cls: 'omi-sidebar-section-title' });
		this.renderTopTags(tagsSection);
	}

	private getMemoriesWeeklyDelta(): number {
		const oneWeekAgo = new Date();
		oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
		return this.memories.filter(m => new Date(m.created_at) >= oneWeekAgo).length;
	}

	private getMemoryStreak(): number {
		if (this.memories.length === 0) return 0;

		// Get unique dates with memories (sorted newest first)
		const datesWithMemories = new Set<string>();
		for (const memory of this.memories) {
			const date = new Date(memory.created_at).toISOString().split('T')[0];
			datesWithMemories.add(date);
		}

		const sortedDates = Array.from(datesWithMemories).sort().reverse();

		// Check if today or yesterday has a memory (streak must be current)
		const today = new Date().toISOString().split('T')[0];
		const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

		if (!sortedDates.includes(today) && !sortedDates.includes(yesterday)) {
			return 0;
		}

		// Count consecutive days
		let streak = 0;
		let checkDate = sortedDates.includes(today) ? new Date() : new Date(Date.now() - 86400000);

		for (let i = 0; i < 365; i++) {
			const dateStr = checkDate.toISOString().split('T')[0];
			if (datesWithMemories.has(dateStr)) {
				streak++;
				checkDate.setDate(checkDate.getDate() - 1);
			} else {
				break;
			}
		}

		return streak;
	}

	private getMemoriesPerDay(days: number): number[] {
		const counts: number[] = new Array(days).fill(0);
		const now = new Date();
		now.setHours(23, 59, 59, 999);

		for (const memory of this.memories) {
			const memoryDate = new Date(memory.created_at);
			const daysAgo = Math.floor((now.getTime() - memoryDate.getTime()) / 86400000);
			if (daysAgo >= 0 && daysAgo < days) {
				counts[days - 1 - daysAgo]++;
			}
		}

		return counts;
	}

	private renderMemoriesSparkline(container: HTMLElement): void {
		const data = this.getMemoriesPerDay(30);
		const maxVal = Math.max(...data, 1);

		const sparklineContainer = container.createDiv('omi-sparkline-container');

		// Create SVG
		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('class', 'omi-sparkline');
		svg.setAttribute('viewBox', '0 0 200 40');
		svg.setAttribute('preserveAspectRatio', 'none');

		// Create gradient
		const defs = document.createElementNS(svgNS, 'defs');
		const gradient = document.createElementNS(svgNS, 'linearGradient');
		gradient.setAttribute('id', 'sparkline-gradient');
		gradient.setAttribute('x1', '0');
		gradient.setAttribute('y1', '0');
		gradient.setAttribute('x2', '0');
		gradient.setAttribute('y2', '1');

		const stop1 = document.createElementNS(svgNS, 'stop');
		stop1.setAttribute('offset', '0%');
		stop1.setAttribute('stop-color', 'var(--interactive-accent)');
		stop1.setAttribute('stop-opacity', '0.3');

		const stop2 = document.createElementNS(svgNS, 'stop');
		stop2.setAttribute('offset', '100%');
		stop2.setAttribute('stop-color', 'var(--interactive-accent)');
		stop2.setAttribute('stop-opacity', '0');

		gradient.appendChild(stop1);
		gradient.appendChild(stop2);
		defs.appendChild(gradient);
		svg.appendChild(defs);

		// Build path points
		const width = 200;
		const height = 40;
		const padding = 2;
		const points: string[] = [];
		const linePoints: string[] = [];

		for (let i = 0; i < data.length; i++) {
			const x = padding + (i / (data.length - 1)) * (width - 2 * padding);
			const y = height - padding - (data[i] / maxVal) * (height - 2 * padding);
			points.push(`${x},${y}`);
			linePoints.push(i === 0 ? `M${x},${y}` : `L${x},${y}`);
		}

		// Area fill
		const areaPath = document.createElementNS(svgNS, 'path');
		const startX = padding;
		const endX = padding + ((data.length - 1) / (data.length - 1)) * (width - 2 * padding);
		areaPath.setAttribute('d', `${linePoints.join(' ')} L${endX},${height} L${startX},${height} Z`);
		areaPath.setAttribute('fill', 'url(#sparkline-gradient)');
		svg.appendChild(areaPath);

		// Line
		const linePath = document.createElementNS(svgNS, 'path');
		linePath.setAttribute('d', linePoints.join(' '));
		linePath.setAttribute('fill', 'none');
		linePath.setAttribute('stroke', 'var(--interactive-accent)');
		linePath.setAttribute('stroke-width', '2');
		linePath.setAttribute('stroke-linecap', 'round');
		linePath.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(linePath);

		sparklineContainer.appendChild(svg);

		// Add label
		const total = data.reduce((a, b) => a + b, 0);
		const label = sparklineContainer.createDiv('omi-sparkline-label');
		label.setText(`${total} memories in 30 days`);
	}

	private renderCategoryBreakdown(container: HTMLElement): void {
		// Get category counts
		const categoryCounts: Record<string, number> = {};
		for (const memory of this.memories) {
			const cat = memory.category || 'other';
			categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
		}

		const total = this.memories.length || 1;
		const sortedCategories = Object.entries(categoryCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8); // Show top 8 categories

		for (const [cat, count] of sortedCategories) {
			const percentage = Math.round((count / total) * 100);
			const emoji = MEMORY_CATEGORY_EMOJI[cat] || '📌';

			const row = container.createDiv('omi-category-bar-row');
			row.addEventListener('click', async () => {
				this.memoriesCategoryFilter = this.memoriesCategoryFilter === cat ? null : cat;
				this.plugin.settings.memoriesCategoryFilter = this.memoriesCategoryFilter;
				await this.plugin.saveSettings();
				this.render();
			});

			// Active state
			if (this.memoriesCategoryFilter === cat) {
				row.addClass('active');
			}

			const labelRow = row.createDiv('omi-category-bar-label');
			labelRow.createEl('span', { text: `${emoji} ${cat}`, cls: 'omi-category-bar-name' });
			labelRow.createEl('span', { text: count.toString(), cls: 'omi-category-bar-count' });

			const barBg = row.createDiv('omi-category-bar-bg');
			const barFill = barBg.createDiv('omi-category-bar-fill');
			barFill.style.width = `${percentage}%`;
		}
	}

	private renderTopTags(container: HTMLElement): void {
		// Count tag frequency
		const tagCounts: Record<string, number> = {};
		for (const memory of this.memories) {
			if (memory.tags) {
				for (const tag of memory.tags) {
					tagCounts[tag] = (tagCounts[tag] || 0) + 1;
				}
			}
		}

		const sortedTags = Object.entries(tagCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10); // Top 10 tags

		if (sortedTags.length === 0) {
			container.createEl('p', { text: 'No tags yet', cls: 'omi-sidebar-empty' });
			return;
		}

		const tagsContainer = container.createDiv('omi-sidebar-tags');
		for (const [tag, count] of sortedTags) {
			const tagPill = tagsContainer.createEl('button', { cls: 'omi-sidebar-tag-pill' });
			tagPill.createEl('span', { text: tag, cls: 'omi-sidebar-tag-name' });
			tagPill.createEl('span', { text: count.toString(), cls: 'omi-sidebar-tag-count' });

			tagPill.addEventListener('click', () => {
				// Set search query to filter by this tag
				this.memoriesSearchQuery = tag;
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

		// Set canvas size - use requestAnimationFrame to ensure layout is ready
		const resizeCanvas = () => {
			const rect = graphContainer.getBoundingClientRect();
			// Use fallback dimensions if container isn't laid out yet
			canvas.width = rect.width > 0 ? rect.width : 600;
			canvas.height = Math.max(400, rect.height > 0 ? rect.height : 400);
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
		// Density indicator
		const densityRow = legend.createDiv('omi-graph-legend-density');
		densityRow.createEl('span', { text: 'Fewer', cls: 'omi-graph-legend-density-label' });
		const gradient = densityRow.createEl('span', { cls: 'omi-graph-legend-gradient' });
		gradient.style.background = 'linear-gradient(to right, #C4B5FD, #6D28D9)';
		densityRow.createEl('span', { text: 'More', cls: 'omi-graph-legend-density-label' });
		legend.createEl('div', { text: 'Scroll to zoom • Drag to pan', cls: 'omi-graph-legend-hint' });

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

		// Store canvas reference for cleanup
		this.graphCanvas = canvas;
		this.graphListeners = [];

		// Zoom handler
		const wheelHandler = (e: WheelEvent) => {
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
		};
		canvas.addEventListener('wheel', wheelHandler, { passive: false });
		this.graphListeners.push({ event: 'wheel', handler: wheelHandler as EventListener, options: { passive: false } });

		// Mouse down - start drag or pan
		const mousedownHandler = (e: MouseEvent) => {
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
		};
		canvas.addEventListener('mousedown', mousedownHandler);
		this.graphListeners.push({ event: 'mousedown', handler: mousedownHandler as EventListener });

		// Mouse move - drag node, pan, or hover
		const mousemoveHandler = (e: MouseEvent) => {
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
		};
		canvas.addEventListener('mousemove', mousemoveHandler);
		this.graphListeners.push({ event: 'mousemove', handler: mousemoveHandler as EventListener });

		// Mouse up - end drag or pan, and handle click
		const mouseupHandler = (e: MouseEvent) => {
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
		};
		canvas.addEventListener('mouseup', mouseupHandler);
		this.graphListeners.push({ event: 'mouseup', handler: mouseupHandler as EventListener });

		const mouseleaveHandler = () => {
			tooltip.style.display = 'none';
			hoveredNode = null;
			isDragging = false;
			draggedNode = null;
			isPanning = false;
		};
		canvas.addEventListener('mouseleave', mouseleaveHandler);
		this.graphListeners.push({ event: 'mouseleave', handler: mouseleaveHandler as EventListener });

		// Double-click to reset zoom
		const dblclickHandler = () => {
			scale = 1;
			offsetX = 0;
			offsetY = 0;
		};
		canvas.addEventListener('dblclick', dblclickHandler);
		this.graphListeners.push({ event: 'dblclick', handler: dblclickHandler as EventListener });

		// Force simulation parameters
		const centerX = canvas.width / 2;
		const centerY = canvas.height / 2;
		const maxRadius = Math.min(canvas.width, canvas.height) * 0.42; // Circular boundary
		const repulsion = 2500; // Strong repulsion to prevent overlap
		const attraction = 0.015; // Gentle attraction along edges
		const damping = 0.75;
		const centerPull = 0.006; // Gentle center pull
		const boundaryForce = 0.2; // Strong boundary to maintain circle

		// Create node lookup for faster access (O(1) instead of O(n) find)
		const nodeMap = new Map<string, typeof nodes[0]>();
		for (const node of nodes) {
			nodeMap.set(node.id, node);
		}

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
			// Stop if context is invalid or this canvas is no longer the active one
			if (!ctx || this.graphCanvas !== canvas) return;
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
					const source = nodeMap.get(edge.source);
					const target = nodeMap.get(edge.target);
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
				const source = nodeMap.get(edge.source);
				const target = nodeMap.get(edge.target);
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

				// Add border for better visibility
				ctx.strokeStyle = isHovered || isSelected || isDragged ? 'var(--text-normal)' : 'rgba(255,255,255,0.3)';
				ctx.lineWidth = (isHovered || isSelected || isDragged ? 2 : 1) / scale;
				ctx.stroke();

				// Always show label for all nodes
				ctx.fillStyle = 'var(--text-normal)';
				const fontSize = ((isHovered || isSelected || isDragged) ? 11 : 9) / scale;
				ctx.font = `${(isHovered || isSelected || isDragged) ? 'bold ' : ''}${fontSize}px sans-serif`;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(node.label, node.x, node.y + radius + 10 / scale);
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

		// Find max count for density scaling
		let maxTagCount = 1;
		for (const [, data] of tagCounts) {
			if (data.count > maxTagCount) maxTagCount = data.count;
		}

		// Density-based color function (purple gradient: light to dark based on count)
		const getDensityColor = (count: number): string => {
			// Normalize count to 0-1 range (using sqrt for better distribution)
			const normalized = Math.sqrt(count / maxTagCount);
			// Interpolate from light purple (#C4B5FD) to deep purple (#6D28D9)
			const lightR = 196, lightG = 181, lightB = 253;
			const darkR = 109, darkG = 40, darkB = 217;
			const r = Math.round(lightR + (darkR - lightR) * normalized);
			const g = Math.round(lightG + (darkG - lightG) * normalized);
			const b = Math.round(lightB + (darkB - lightB) * normalized);
			return `rgb(${r}, ${g}, ${b})`;
		};

		// Build nodes with density-based coloring
		const nodes = Array.from(tagCounts.entries()).map(([tag, data]) => {
			return {
				id: tag,
				label: tag,
				count: data.count,
				x: 0,
				y: 0,
				vx: 0,
				vy: 0,
				color: getDensityColor(data.count)
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

		// Always render Daily view
		this.renderConversationsDailyView(tabContent);
	}

	private async handleConversationSync(fullResync: boolean): Promise<void> {
		this.isSyncingConversations = true;
		this.render();

		try {
			await this.plugin.syncConversations(fullResync);
			// Invalidate stats cache after sync since data may have changed
			this.invalidateStatsCache();
		} finally {
			this.isSyncingConversations = false;
			this.render();
		}
	}

	/** Invalidate the stats cache to force recomputation on next render */
	invalidateStatsCache(): void {
		this.statsCacheKey = null;
		this.cachedStatsData = null;
	}

	private renderConversationCard(container: HTMLElement, conv: SyncedConversationMeta, showDate = false): void {
		const isSelected = this.selectedConversationId === conv.id;
		const card = container.createDiv(`omi-conversation-card${isSelected ? ' selected' : ''}`);
		card.setAttribute('data-conversation-id', conv.id);
		card.setAttribute('role', 'button');
		card.setAttribute('tabindex', '0');
		card.setAttribute('aria-selected', String(isSelected));

		// Time row (top-left for easy scanning)
		const timeRow = card.createDiv('omi-conversation-time-row');
		const timeText = showDate
			? `${new Date(conv.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${conv.time}`
			: conv.time;
		timeRow.createEl('span', { text: timeText, cls: 'omi-conversation-time' });
		if (conv.duration && conv.duration > 0) {
			timeRow.createEl('span', {
				text: `· ${this.formatDuration(conv.duration)}`,
				cls: 'omi-conversation-duration'
			});
		}

		// Title row: emoji + title
		const header = card.createDiv('omi-conversation-card-header');
		header.createEl('span', { text: conv.emoji || '💬', cls: 'omi-conversation-emoji' });
		header.createEl('span', { text: conv.title || 'Untitled', cls: 'omi-conversation-title' });

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

	private formatDuration(minutes: number, detailed: boolean = false): string {
		if (minutes < 60) {
			return `${minutes}m`;
		}
		const hours = Math.floor(minutes / 60);
		const mins = minutes % 60;
		if (detailed) {
			return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
		}
		// Clean rounding: round to nearest hour
		const roundedHours = Math.round(minutes / 60);
		return `${roundedHours}h`;
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

		// Location section with mini map
		if (conv.geolocation?.latitude && conv.geolocation?.longitude) {
			const locationSection = container.createDiv('omi-detail-section omi-detail-location');
			locationSection.createEl('h4', { text: '📍 Location' });

			// Address text
			if (conv.geolocation.address) {
				locationSection.createEl('p', {
					text: conv.geolocation.address,
					cls: 'omi-detail-location-address'
				});
			}

			// Mini map using OpenStreetMap embed (free, no API key)
			const lat = conv.geolocation.latitude;
			const lon = conv.geolocation.longitude;
			const mapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${lon - 0.005},${lat - 0.005},${lon + 0.005},${lat + 0.005}&layer=mapnik&marker=${lat},${lon}`;

			locationSection.createEl('iframe', {
				cls: 'omi-detail-map',
				attr: {
					src: mapUrl,
					width: '100%',
					height: '150',
					frameborder: '0',
					scrolling: 'no'
				}
			});
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

	// Convert YYYY-MM-DD to YYYY/MM/DD folder path
	private getDateFolderPath(basePath: string, dateStr: string): string {
		const [year, month, day] = dateStr.split('-');
		return `${basePath}/${year}/${month}/${day}`;
	}

	private async loadConversationDetails(convId: string): Promise<void> {
		const conv = this.plugin.settings.syncedConversations[convId];
		if (!conv) return;

		this.isLoadingDetail = true;
		this.selectedConversationData = null;

		try {
			const folderPath = this.plugin.settings.folderPath;
			const basePath = this.getDateFolderPath(folderPath, conv.date);

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
			// Skip location line (displayed separately in detail panel)
			if (line.startsWith('📍')) continue;
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

		// Auto-select first conversation if none selected
		if (!this.selectedConversationId) {
			const dayConvs = this.getConversationsForDate(displayDate);
			if (dayConvs.length > 0) {
				this.selectedConversationId = dayConvs[0].id;
				// Load details and re-render when done
				this.loadConversationDetails(dayConvs[0].id).then(() => this.render());
			}
		}

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
		block.setAttribute('title', `${conv.emoji} ${conv.title}\n${conv.time} - ${this.formatDuration(duration, true)}`);
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
			// Scroll the selected card into view
			setTimeout(() => {
				const selectedCard = this.containerEl.querySelector(`[data-conversation-id="${conv.id}"]`);
				selectedCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			}, 0);
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

	// ==================== HEATMAP TAB ====================

	private renderHeatmapTab(container: HTMLElement): void {
		const tabContent = container.createDiv('omi-heatmap-container');

		const conversations = this.plugin.settings.syncedConversations || {};
		const conversationArray = Object.values(conversations) as SyncedConversationMeta[];

		if (conversationArray.length === 0) {
			const empty = tabContent.createDiv('omi-conversations-empty');
			empty.createEl('div', { text: '📅', cls: 'omi-empty-icon' });
			empty.createEl('h3', { text: 'No heatmap data available' });
			empty.createEl('p', { text: 'Sync conversations to see your activity heatmap' });
			return;
		}

		this.renderConversationsHeatmap(tabContent);
	}

	// ==================== MAP TAB ====================

	private renderMapTab(container: HTMLElement): void {
		const tabContent = container.createDiv('omi-map-container');

		const conversations = this.plugin.settings.syncedConversations || {};
		const conversationArray = Object.values(conversations) as SyncedConversationMeta[];
		const withLocation = conversationArray.filter(c => c.geolocation?.latitude && c.geolocation?.longitude);

		if (withLocation.length === 0) {
			const empty = tabContent.createDiv('omi-conversations-empty');
			empty.createEl('div', { text: '🗺️', cls: 'omi-empty-icon' });
			empty.createEl('h3', { text: 'No location data available' });
			empty.createEl('p', { text: 'Sync conversations with geolocation to see your map' });
			return;
		}

		this.renderConversationsMap(tabContent);
	}

	// ==================== SYNC TAB ====================

	private renderSyncTab(container: HTMLElement): void {
		const tabContent = container.createDiv('omi-sync-dashboard');

		// Subscribe to sync progress updates for live updates
		if (this.unsubscribeSyncProgress) {
			this.unsubscribeSyncProgress();
		}
		this.unsubscribeSyncProgress = this.plugin.onSyncProgress(() => {
			// Only update if we're on the sync tab
			if (this.activeTab === 'sync') {
				// Update live banner in-place instead of full re-render
				this.updateSyncLiveBanner(tabContent);
			}
		});

		// Live Status Banner (only visible during sync)
		if (this.plugin.syncProgress.isActive) {
			this.renderSyncLiveBanner(tabContent);
		}

		// Status Cards Grid
		const cardsGrid = tabContent.createDiv('omi-sync-cards');
		this.renderSyncCardNew(cardsGrid, 'conversations');
		this.renderSyncCardNew(cardsGrid, 'tasks');
		this.renderSyncCardNew(cardsGrid, 'memories');

		// API Rate Monitor
		this.renderApiRateMonitor(tabContent);

		// Sync History Log
		this.renderSyncLogTimeline(tabContent);
	}

	private renderApiRateMonitor(container: HTMLElement): void {
		const callsPerMin = this.plugin.getApiCallsPerMinute();
		const rateStatus = callsPerMin > 80 ? 'warning' : callsPerMin > 50 ? 'caution' : 'normal';

		const rateContainer = container.createDiv('omi-sync-rate');
		rateContainer.createSpan({
			cls: 'omi-sync-rate__icon',
			text: '⚡'
		});
		rateContainer.createSpan({
			cls: `omi-sync-rate__value omi-sync-rate__value--${rateStatus}`,
			text: `${callsPerMin}/min`
		});
		rateContainer.createSpan({
			cls: 'omi-sync-rate__label',
			text: 'API calls'
		});
		rateContainer.createSpan({
			cls: 'omi-sync-rate__limit',
			text: '(limit: 100/min)'
		});
	}

	// Update live banner in-place without re-rendering everything
	private updateSyncLiveBanner(container: HTMLElement): void {
		const progress = this.plugin.syncProgress;
		const existingBanner = container.querySelector('.omi-sync-live-banner');

		// If sync just finished, remove banner and do a full render to update cards/log
		if (!progress.isActive) {
			if (existingBanner) {
				existingBanner.remove();
			}
			this.render();
			return;
		}

		// If sync just started but no banner exists, do a full render to add it
		if (!existingBanner) {
			this.render();
			return;
		}

		// Update existing banner elements in-place
		const titleEl = existingBanner.querySelector('.omi-sync-live-title');
		if (titleEl) {
			titleEl.textContent = progress.isCancelled ? 'Cancelling...' : `Syncing ${progress.type}...`;
		}

		const stepEl = existingBanner.querySelector('.omi-sync-live-step');
		if (stepEl) {
			stepEl.textContent = progress.step;
		}

		const fillEl = existingBanner.querySelector('.omi-sync-progress-fill') as HTMLElement;
		if (fillEl) {
			fillEl.style.width = `${Math.min(100, progress.progress)}%`;
		}

		// Handle cancel button visibility
		const cancelBtn = existingBanner.querySelector('.omi-sync-cancel-btn');
		if (progress.isCancelled && cancelBtn) {
			cancelBtn.remove();
		}

		// Also update conversations count in-place if syncing conversations
		if (progress.type === 'conversations') {
			const countEl = container.querySelector('[data-stat-type="conversations-count"]');
			if (countEl) {
				const currentCount = Object.keys(this.plugin.settings.syncedConversations || {}).length;
				countEl.textContent = currentCount.toString();
			}
		}
	}

	private renderSyncLiveBanner(container: HTMLElement): void {
		const progress = this.plugin.syncProgress;
		const banner = container.createDiv('omi-sync-live-banner');

		// Pulsing indicator
		banner.createDiv('omi-sync-live-indicator');

		// Content
		const content = banner.createDiv('omi-sync-live-content');
		content.createDiv({
			cls: 'omi-sync-live-title',
			text: progress.isCancelled ? 'Cancelling...' : `Syncing ${progress.type}...`
		});
		content.createDiv({
			cls: 'omi-sync-live-step',
			text: progress.step
		});

		// Cancel button (only if not already cancelled)
		if (!progress.isCancelled) {
			const cancelBtn = banner.createEl('button', {
				cls: 'omi-sync-cancel-btn',
				text: 'Cancel'
			});
			cancelBtn.addEventListener('click', () => {
				this.plugin.cancelSync();
			});
		}

		// Progress track
		const progressTrack = banner.createDiv('omi-sync-progress-track');
		const progressFill = progressTrack.createDiv('omi-sync-progress-fill');
		progressFill.style.width = `${Math.min(100, progress.progress)}%`;
	}

	private renderSyncCardNew(container: HTMLElement, type: 'conversations' | 'tasks' | 'memories'): void {
		const settings = this.plugin.settings;
		const isSyncing = this.plugin.syncProgress.isActive && this.plugin.syncProgress.type === type;

		// Determine status
		let status: 'synced' | 'syncing' | 'error' | 'never' = 'never';
		let lastSync: string | null = null;

		if (type === 'conversations') {
			lastSync = settings.lastConversationSyncTimestamp;
		} else if (type === 'tasks') {
			lastSync = settings.lastTasksSyncTimestamp;
		} else {
			lastSync = settings.lastMemoriesSyncTimestamp;
		}

		// Check for errors - only show error if the MOST RECENT sync for this type had an error
		// This ensures successful syncs clear the error state
		const mostRecentEntry = settings.syncHistory.find(e => e.type === type);
		const hasRecentError = mostRecentEntry?.error !== undefined;

		if (isSyncing) {
			status = 'syncing';
		} else if (hasRecentError) {
			status = 'error';
		} else if (lastSync) {
			status = 'synced';
		}

		// Card element with type and status classes
		const card = container.createDiv({
			cls: `omi-sync-card omi-sync-card--${type} omi-sync-card--${status}`
		});

		// Header
		const header = card.createDiv('omi-sync-card__header');

		// Icon
		const icon = header.createDiv('omi-sync-card__icon');
		const iconEmoji = type === 'conversations' ? '💬' : type === 'tasks' ? '✓' : '🧠';
		icon.setText(iconEmoji);

		// Title group
		const titleGroup = header.createDiv('omi-sync-card__title-group');
		titleGroup.createDiv({
			cls: 'omi-sync-card__title',
			text: this.capitalizeFirst(type)
		});
		titleGroup.createDiv({
			cls: 'omi-sync-card__subtitle',
			text: lastSync ? `Last: ${this.getRelativeTime(new Date(lastSync))}` : 'Never synced'
		});

		// Status badge
		const statusBadge = header.createDiv('omi-sync-card__status');
		statusBadge.createDiv('omi-sync-card__status-dot');
		const statusText = isSyncing ? 'Syncing' : (status === 'error' ? 'Error' : (lastSync ? 'Synced' : 'Ready'));
		statusBadge.createSpan({ text: statusText });

		// Stats
		const stats = card.createDiv('omi-sync-card__stats');
		this.renderSyncCardStats(stats, type);

		// Settings row
		const settingsRow = card.createDiv('omi-sync-card__settings');
		this.renderSyncCardSettings(settingsRow, type);

		// Actions
		const actions = card.createDiv('omi-sync-card__actions');
		this.renderSyncCardActions(actions, type, isSyncing);

		// Advanced Options (conversations only)
		if (type === 'conversations') {
			this.renderSyncCardAdvanced(card, isSyncing);
		}
	}

	private renderSyncCardStats(container: HTMLElement, type: string): void {
		const settings = this.plugin.settings;

		if (type === 'conversations') {
			const count = Object.keys(settings.syncedConversations || {}).length;
			this.createSyncStatItem(container, count.toString(), 'tracked', 'conversations-count');
		} else if (type === 'tasks') {
			const pending = this.tasks.filter(t => !t.completed).length;
			const total = this.tasks.length;
			this.createSyncStatItem(container, total.toString(), 'tasks');
			this.createSyncStatItem(container, pending.toString(), 'pending');
		} else {
			const count = this.memories.length;
			this.createSyncStatItem(container, count.toString(), 'memories');
		}
	}

	private createSyncStatItem(container: HTMLElement, value: string, label: string, dataType?: string): void {
		const stat = container.createDiv('omi-sync-card__stat');
		const valueEl = stat.createDiv({ cls: 'omi-sync-card__stat-value', text: value });
		if (dataType) {
			valueEl.setAttribute('data-stat-type', dataType);
		}
		stat.createDiv({ cls: 'omi-sync-card__stat-label', text: label });
	}

	private renderSyncCardSettings(container: HTMLElement, type: string): void {
		const settings = this.plugin.settings;

		if (type === 'conversations') {
			// Row 1: Auto-sync toggle + interval
			const autoSyncRow = container.createDiv('omi-sync-card__setting');
			const autoSyncEnabled = settings.conversationAutoSync > 0;
			autoSyncRow.createSpan({ cls: 'omi-sync-card__setting-label', text: 'Auto-sync:' });

			const toggle = autoSyncRow.createDiv({
				cls: `omi-sync-toggle ${autoSyncEnabled ? 'omi-sync-toggle--active' : ''}`
			});
			toggle.createDiv('omi-sync-toggle__knob');
			toggle.addEventListener('click', async () => {
				if (autoSyncEnabled) {
					settings.conversationAutoSync = 0;
				} else {
					settings.conversationAutoSync = 30;
				}
				await this.plugin.saveSettings();
				this.plugin.setupConversationAutoSync();
				this.render();
			});

			// Interval dropdown
			const select = container.createEl('select', { cls: 'omi-sync-card__select' });
			const intervals = [
				{ value: '30', label: '30 min' },
				{ value: '60', label: '1 hour' },
				{ value: '120', label: '2 hours' },
				{ value: '360', label: '6 hours' }
			];
			for (const opt of intervals) {
				const option = select.createEl('option', { value: opt.value, text: opt.label });
				if (settings.conversationAutoSync === parseInt(opt.value) ||
					(settings.conversationAutoSync === 0 && opt.value === '30')) {
					option.selected = true;
				}
			}
			select.addEventListener('change', async () => {
				settings.conversationAutoSync = parseInt(select.value);
				await this.plugin.saveSettings();
				this.plugin.setupConversationAutoSync();
				this.render();
			});

			// Row 2: Start date setting
			const startDateRow = container.createDiv('omi-sync-card__setting');
			startDateRow.createSpan({ cls: 'omi-sync-card__setting-label', text: 'From:' });
			const dateInput = startDateRow.createEl('input', {
				cls: 'omi-sync-card__date-input',
				type: 'date',
				value: settings.startDate
			});
			dateInput.addEventListener('change', async () => {
				settings.startDate = dateInput.value;
				await this.plugin.saveSettings();
				new Notice(`Start date set to ${dateInput.value}`);
			});
		} else if (type === 'tasks') {
			// Tasks Hub toggle
			const setting = container.createDiv('omi-sync-card__setting');
			setting.createSpan({ cls: 'omi-sync-card__setting-label', text: 'Tasks Hub:' });

			const toggle = setting.createDiv({
				cls: `omi-sync-toggle ${settings.enableTasksHub ? 'omi-sync-toggle--active' : ''}`
			});
			toggle.createDiv('omi-sync-toggle__knob');
			toggle.addEventListener('click', async () => {
				settings.enableTasksHub = !settings.enableTasksHub;
				await this.plugin.saveSettings();
				if (settings.enableTasksHub) {
					await this.plugin.initializeTasksHub();
				} else {
					this.plugin.stopTasksHubPeriodicSync();
				}
				this.render();
			});

			// Interval dropdown
			const select = container.createEl('select', { cls: 'omi-sync-card__select' });
			const intervals = [
				{ value: '5', label: '5 min' },
				{ value: '10', label: '10 min' },
				{ value: '15', label: '15 min' },
				{ value: '30', label: '30 min' }
			];
			for (const opt of intervals) {
				const option = select.createEl('option', { value: opt.value, text: opt.label });
				if (settings.tasksViewAutoRefresh === parseInt(opt.value)) {
					option.selected = true;
				}
			}
			select.addEventListener('change', async () => {
				settings.tasksViewAutoRefresh = parseInt(select.value);
				await this.plugin.saveSettings();
			});
		} else if (type === 'memories') {
			// Auto-refresh
			const setting = container.createDiv('omi-sync-card__setting');
			setting.createSpan({ cls: 'omi-sync-card__setting-label', text: 'Auto-refresh:' });

			const select = container.createEl('select', { cls: 'omi-sync-card__select' });
			const intervals = [
				{ value: '5', label: '5 min' },
				{ value: '10', label: '10 min' },
				{ value: '15', label: '15 min' },
				{ value: '30', label: '30 min' }
			];
			for (const opt of intervals) {
				const option = select.createEl('option', { value: opt.value, text: opt.label });
				if (settings.memoriesViewAutoRefresh === parseInt(opt.value)) {
					option.selected = true;
				}
			}
			select.addEventListener('change', async () => {
				settings.memoriesViewAutoRefresh = parseInt(select.value);
				await this.plugin.saveSettings();
			});
		}
	}

	private renderSyncCardActions(container: HTMLElement, type: string, isSyncing: boolean): void {
		const settings = this.plugin.settings;

		if (type === 'conversations') {
			// Sync New button
			const syncBtn = container.createEl('button', {
				cls: `omi-sync-card__btn omi-sync-card__btn--primary ${isSyncing ? 'omi-sync-card__btn--syncing' : ''}`
			});
			if (isSyncing) {
				syncBtn.createDiv('omi-sync-card__btn-spinner');
				syncBtn.createSpan({ text: 'Syncing...' });
			} else {
				syncBtn.setText('Sync New');
				syncBtn.addEventListener('click', () => this.plugin.syncConversations(false));
			}

			// Full Resync button
			const fullSyncBtn = container.createEl('button', {
				text: 'Full Resync',
				cls: 'omi-sync-card__btn omi-sync-card__btn--secondary'
			});
			fullSyncBtn.disabled = isSyncing;
			fullSyncBtn.addEventListener('click', () => {
				if (confirm('This will re-fetch all conversations. Continue?')) {
					this.plugin.syncConversations(true);
				}
			});
		} else if (type === 'tasks') {
			const refreshBtn = container.createEl('button', {
				cls: `omi-sync-card__btn omi-sync-card__btn--primary ${isSyncing ? 'omi-sync-card__btn--syncing' : ''}`
			});
			if (isSyncing) {
				refreshBtn.createDiv('omi-sync-card__btn-spinner');
				refreshBtn.createSpan({ text: 'Refreshing...' });
			} else {
				refreshBtn.setText('Refresh Now');
				refreshBtn.disabled = !settings.enableTasksHub;
				refreshBtn.addEventListener('click', async () => {
					await this.loadTasks(true);
					// Log to sync history and update timestamp
					this.plugin.settings.lastTasksSyncTimestamp = new Date().toISOString();
					this.plugin.settings.syncHistory.unshift({
						timestamp: new Date().toISOString(),
						type: 'tasks',
						action: 'sync',
						count: this.tasks.length
					});
					// Prune old entries
					const cutoff = Date.now() - 24 * 60 * 60 * 1000;
					this.plugin.settings.syncHistory = this.plugin.settings.syncHistory
						.filter(e => new Date(e.timestamp).getTime() > cutoff)
						.slice(0, 100);
					await this.plugin.saveSettings();
					this.render();
					new Notice(`Tasks refreshed (${this.tasks.length} tasks)`);
				});
			}
		} else if (type === 'memories') {
			const refreshBtn = container.createEl('button', {
				cls: `omi-sync-card__btn omi-sync-card__btn--primary ${isSyncing ? 'omi-sync-card__btn--syncing' : ''}`
			});
			if (isSyncing) {
				refreshBtn.createDiv('omi-sync-card__btn-spinner');
				refreshBtn.createSpan({ text: 'Refreshing...' });
			} else {
				refreshBtn.setText('Refresh Now');
				refreshBtn.addEventListener('click', async () => {
					await this.loadMemories(true);
					// Log to sync history and update timestamp
					this.plugin.settings.lastMemoriesSyncTimestamp = new Date().toISOString();
					this.plugin.settings.syncHistory.unshift({
						timestamp: new Date().toISOString(),
						type: 'memories',
						action: 'sync',
						count: this.memories.length
					});
					// Prune old entries
					const cutoff = Date.now() - 24 * 60 * 60 * 1000;
					this.plugin.settings.syncHistory = this.plugin.settings.syncHistory
						.filter(e => new Date(e.timestamp).getTime() > cutoff)
						.slice(0, 100);
					await this.plugin.saveSettings();
					this.render();
					new Notice(`Memories refreshed (${this.memories.length} memories)`);
				});
			}
		}
	}

	/**
	 * Render collapsible Advanced Options section for Conversations card
	 * Contains "Resync Date Range" feature (single day or range)
	 */
	private renderSyncCardAdvanced(card: HTMLElement, isSyncing: boolean): void {
		const advancedSection = card.createDiv('omi-sync-card__advanced');

		// Collapsible header
		const advancedHeader = advancedSection.createDiv('omi-sync-card__advanced-header');
		const toggleIcon = advancedHeader.createSpan({ cls: 'omi-sync-card__advanced-icon', text: '▶' });
		advancedHeader.createSpan({ text: 'Advanced Options' });

		// Hidden content (shown on click)
		const advancedContent = advancedSection.createDiv('omi-sync-card__advanced-content');
		advancedContent.style.display = 'none';

		// Resync Date Range section
		const resyncDaySection = advancedContent.createDiv('omi-sync-card__resync-day');
		resyncDaySection.createDiv({
			cls: 'omi-sync-card__resync-day-title',
			text: 'Resync Date Range'
		});
		resyncDaySection.createDiv({
			cls: 'omi-sync-card__resync-day-desc',
			text: 'Re-fetch conversations for a specific date or date range (useful when Omi device loads historical data)'
		});

		// Date picker row - Start date
		const startDateRow = resyncDaySection.createDiv('omi-sync-card__resync-day-row');
		startDateRow.createEl('label', {
			text: 'From:',
			cls: 'omi-sync-card__date-label'
		});

		const startDateInput = startDateRow.createEl('input', {
			type: 'date',
			cls: 'omi-sync-card__date-input omi-sync-card__resync-date'
		});
		// Default to today
		const today = new Date();
		startDateInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

		// Date picker row - End date (optional)
		const endDateRow = resyncDaySection.createDiv('omi-sync-card__resync-day-row');
		endDateRow.createEl('label', {
			text: 'To:',
			cls: 'omi-sync-card__date-label'
		});

		const endDateInput = endDateRow.createEl('input', {
			type: 'date',
			cls: 'omi-sync-card__date-input omi-sync-card__resync-date'
		});
		// Leave empty by default (single day mode)

		// Helper text
		resyncDaySection.createDiv({
			cls: 'omi-sync-card__resync-day-hint',
			text: 'Leave "To" empty to resync a single day'
		});

		// Button row
		const buttonRow = resyncDaySection.createDiv('omi-sync-card__resync-day-row omi-sync-card__resync-day-buttons');

		const resyncBtn = buttonRow.createEl('button', {
			text: 'Resync',
			cls: 'omi-sync-card__btn omi-sync-card__btn--secondary'
		});
		resyncBtn.disabled = isSyncing;
		resyncBtn.addEventListener('click', async () => {
			const startDate = startDateInput.value;
			const endDate = endDateInput.value || undefined;

			if (!startDate) {
				new Notice('Please select a start date');
				return;
			}

			// Validate end date is not before start date
			if (endDate && endDate < startDate) {
				new Notice('End date cannot be before start date');
				return;
			}

			await this.plugin.resyncDay(startDate, endDate);
			this.render();
		});

		// Toggle visibility on header click
		advancedHeader.addEventListener('click', () => {
			const isHidden = advancedContent.style.display === 'none';
			advancedContent.style.display = isHidden ? 'block' : 'none';
			toggleIcon.textContent = isHidden ? '▼' : '▶';
			advancedSection.toggleClass('omi-sync-card__advanced--open', isHidden);
		});
	}

	private renderSyncLogTimeline(container: HTMLElement): void {
		const log = container.createDiv('omi-sync-log');

		// Header
		const header = log.createDiv('omi-sync-log__header');
		const title = header.createDiv('omi-sync-log__title');
		title.createSpan({ cls: 'omi-sync-log__title-icon', text: '📋' });
		title.createSpan({ text: 'Activity Log' });

		const history = this.plugin.settings.syncHistory || [];
		header.createDiv({ cls: 'omi-sync-log__badge', text: 'Last 24h' });

		const list = log.createDiv('omi-sync-log__list');

		if (history.length === 0) {
			const empty = list.createDiv('omi-sync-log__empty');
			empty.createDiv({ cls: 'omi-sync-log__empty-icon', text: '📭' });
			empty.createDiv({ cls: 'omi-sync-log__empty-text', text: 'No sync activity yet' });
			return;
		}

		for (const entry of history.slice(0, 20)) {
			const entryEl = list.createDiv({
				cls: `omi-sync-log__entry omi-sync-log__entry--${entry.error ? 'error' : 'success'}`
			});

			// Timeline connector with dot
			const connector = entryEl.createDiv('omi-sync-log__connector');
			connector.createDiv('omi-sync-log__dot');

			// Content
			const content = entryEl.createDiv('omi-sync-log__content');
			const main = content.createDiv('omi-sync-log__main');
			main.createSpan({ cls: 'omi-sync-log__type', text: this.capitalizeFirst(entry.type) });

			// Action tag
			if (entry.action === 'full-resync') {
				main.createSpan({ cls: 'omi-sync-log__tag omi-sync-log__tag--full', text: 'Full' });
			} else if (entry.action === 'auto-sync') {
				main.createSpan({ cls: 'omi-sync-log__tag omi-sync-log__tag--auto', text: 'Auto' });
			} else if (entry.action === 'resync') {
				main.createSpan({ cls: 'omi-sync-log__tag omi-sync-log__tag--resync', text: 'Resync' });
			}

			// Details
			let details: string;
			if (entry.error) {
				details = entry.error;
			} else if (entry.count === 0) {
				details = 'No new items';
			} else {
				details = `${entry.count} items`;
				if (entry.apiCalls) {
					details += ` (${entry.apiCalls} API call${entry.apiCalls > 1 ? 's' : ''})`;
				}
			}
			content.createDiv({
				cls: `omi-sync-log__details ${entry.error ? 'omi-sync-log__details--error' : ''}`,
				text: details
			});

			// Time
			const time = new Date(entry.timestamp);
			const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
			entryEl.createDiv({ cls: 'omi-sync-log__time', text: timeStr });
		}
	}

	private getRelativeTime(date: Date): string {
		const now = Date.now();
		const diff = now - date.getTime();
		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);

		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes} min ago`;
		if (hours < 24) return `${hours}h ago`;
		return date.toLocaleDateString();
	}

	private capitalizeFirst(str: string): string {
		return str.charAt(0).toUpperCase() + str.slice(1);
	}

	// ==================== STATS TAB ====================

	private renderStatsTab(container: HTMLElement): void {
		const tabContent = container.createDiv('omi-stats-container');
		const statsContainer = tabContent.createDiv('omi-conversations-stats omi-stats-dashboard');

		const conversations = this.plugin.settings.syncedConversations || {};
		const conversationArray = Object.values(conversations) as SyncedConversationMeta[];

		if (conversationArray.length === 0) {
			const empty = statsContainer.createDiv('omi-conversations-empty');
			empty.createEl('div', { text: '📊', cls: 'omi-empty-icon' });
			empty.createEl('h3', { text: 'No statistics available' });
			empty.createEl('p', { text: 'Sync conversations to see your stats' });
			return;
		}

		// Load stats data (memories and tasks) if not already loaded
		if (!this.statsDataLoaded && !this.isLoadingStats) {
			this.loadStatsData();
		}

		// Time range selector
		this.renderStatsTimeRange(statsContainer);

		// Compute all stats data
		const stats = this.computeStatsData(conversationArray);

		// Insights Banner
		this.renderInsightsBanner(statsContainer, stats);

		// Main tile grid
		const grid = statsContainer.createDiv('omi-stats-grid');

		// Row 1: KPI tiles
		this.renderConversationsKPITile(grid, stats);
		this.renderTimeRecordedKPITile(grid, stats);
		this.renderAchievementsTile(grid, stats);

		// Row 2: Time patterns heatmap (full width)
		this.renderTimePatternHeatmap(grid, stats);

		// Activity Insights with rotating highlights
		this.renderInsightsSummary(grid, stats);

		// Row 3: Categories and Duration Distribution
		this.renderCategoryTilesGrid(grid, stats);
		this.renderDurationDistributionTile(grid, stats);

		// Row 4: Memories and Tasks
		this.renderMemoriesTile(grid, stats);
		this.renderTaskPerformanceTile(grid, stats);

		// Row 5: Locations (if data exists)
		if (stats.uniqueLocations > 0) {
			this.renderLocationsTile(grid, stats);
		}
	}

	private async loadStatsData(): Promise<void> {
		this.isLoadingStats = true;
		try {
			// Load memories and tasks in parallel
			const [memories, tasks] = await Promise.all([
				this.plugin.api.getAllMemories(this.plugin.settings.memoriesFetchLimit).catch(() => []),
				this.plugin.api.getAllActionItems().catch(() => [])
			]);
			this.statsMemories = memories;
			this.statsTasks = tasks;
			this.statsDataLoaded = true;
			this.render(); // Re-render with loaded data
		} catch (error) {
			console.error('Error loading stats data:', error);
		} finally {
			this.isLoadingStats = false;
		}
	}

	private renderStatsTimeRange(container: HTMLElement): void {
		const timeRangeContainer = container.createDiv('omi-stats-time-range');
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
	}

	private computeStatsData(conversationArray: SyncedConversationMeta[]): StatsData {
		// Generate cache key based on time range and conversation count
		const cacheKey = `${this.statsTimeRange}-${conversationArray.length}-${this.statsDataLoaded}`;

		// Return cached data if cache key matches
		if (this.statsCacheKey === cacheKey && this.cachedStatsData) {
			return this.cachedStatsData;
		}

		const now = new Date();
		let startDate: Date;
		let endDate = now;

		// Determine time range
		switch (this.statsTimeRange) {
			case 'week':
				startDate = this.getWeekStartDate(now);
				break;
			case 'month':
				startDate = new Date(now.getFullYear(), now.getMonth(), 1);
				break;
			case '30days':
				startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
				break;
			case 'all':
			default:
				startDate = new Date(0);
		}

		// Filter conversations
		const filteredConvs = conversationArray.filter(c => {
			const convDate = new Date(c.date + 'T00:00:00');
			return convDate >= startDate && convDate <= endDate;
		});

		// Basic stats
		const conversationCount = filteredConvs.length;
		const totalDuration = filteredConvs.reduce((sum, c) => sum + (c.duration || 0), 0);
		const avgDuration = conversationCount > 0 ? totalDuration / conversationCount : 0;

		// Compute previous period for comparison
		const periodLength = endDate.getTime() - startDate.getTime();
		const prevStart = new Date(startDate.getTime() - periodLength);
		const prevEnd = new Date(startDate.getTime() - 1);

		const prevConvs = this.statsTimeRange !== 'all' ? conversationArray.filter(c => {
			const convDate = new Date(c.date + 'T00:00:00');
			return convDate >= prevStart && convDate <= prevEnd;
		}) : [];

		const prevPeriodConversations = prevConvs.length;
		const prevPeriodDuration = prevConvs.reduce((sum, c) => sum + (c.duration || 0), 0);

		const conversationTrend = prevPeriodConversations > 0
			? ((conversationCount - prevPeriodConversations) / prevPeriodConversations) * 100
			: 0;
		const durationTrend = prevPeriodDuration > 0
			? ((totalDuration - prevPeriodDuration) / prevPeriodDuration) * 100
			: 0;

		// Weekly data for sparklines (last 12 weeks)
		const weeklyConversations: number[] = [];
		const weeklyDuration: number[] = [];
		for (let i = 11; i >= 0; i--) {
			const weekEnd = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
			const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
			const weekConvs = conversationArray.filter(c => {
				const convDate = new Date(c.date + 'T00:00:00');
				return convDate >= weekStart && convDate < weekEnd;
			});
			weeklyConversations.push(weekConvs.length);
			weeklyDuration.push(weekConvs.reduce((sum, c) => sum + (c.duration || 0), 0));
		}

		// Hour x Day heatmap
		const heatmap = this.computeHourDayHeatmap(filteredConvs);
		const { peakDay, peakHour } = this.findPeakTime(heatmap);

		// Streak calculation
		const streak = this.computeStreak(conversationArray);

		// Categories (with previous period comparison)
		const categories = this.computeCategoryStats(filteredConvs, totalDuration, prevConvs);
		const topCategory = categories.length > 0 ? categories[0].category : 'N/A';

		// Duration distribution
		const durationBuckets = this.computeDurationDistribution(filteredConvs);

		// Memory stats
		const memoryStats = this.computeMemoryStats();

		// Task stats
		const taskStats = this.computeTaskStats();

		// Location stats
		const { uniqueLocations, topLocations, countries, states, cities } = this.computeLocationStats(filteredConvs);

		// Time-based counts for achievements
		const lateNightCount = filteredConvs.filter(c => {
			const hour = this.parseTimeToHour(c.time);
			return hour >= 22 || hour < 4;
		}).length;

		const earlyMorningCount = filteredConvs.filter(c => {
			const hour = this.parseTimeToHour(c.time);
			return hour >= 5 && hour < 8;
		}).length;

		// Compute achievement data (all-time metrics)
		const achievementData: AchievementData = {
			conversationCount: conversationArray.length,
			streak,
			lateNightCount,
			earlyMorningCount,
			uniqueLocations,
			memoryCount: memoryStats?.total || 0,
			completedTasksCount: taskStats?.completed || 0,
			longestConversationMinutes: this.getLongestConversationMinutes(conversationArray),
			conversationsOver30Min: this.countConversationsOverMinutes(conversationArray, 30),
			conversationsOver60Min: this.countConversationsOverMinutes(conversationArray, 60),
			totalHoursRecorded: totalDuration / 60, // totalDuration is in minutes
			uniqueCategories: this.countUniqueCategories(conversationArray),
			daysSinceFirstConversation: this.getDaysSinceFirstConversation(conversationArray)
		};
		const achievements = this.computeAchievements(achievementData);

		const result: StatsData = {
			timeRange: this.statsTimeRange,
			startDate,
			endDate,
			conversationCount,
			totalDuration,
			avgDuration,
			weeklyConversations,
			weeklyDuration,
			prevPeriodConversations,
			prevPeriodDuration,
			conversationTrend,
			durationTrend,
			heatmap,
			peakDay,
			peakHour,
			streak,
			categories,
			topCategory,
			durationBuckets,
			memoryStats,
			taskStats,
			uniqueLocations,
			topLocations,
			countries,
			states,
			cities,
			achievements,
			lateNightCount,
			earlyMorningCount
		};

		// Cache the result
		this.statsCacheKey = cacheKey;
		this.cachedStatsData = result;

		return result;
	}

	private computeHourDayHeatmap(convs: SyncedConversationMeta[]): HeatmapCell[] {
		const cells: HeatmapCell[] = [];
		const data = new Map<string, { count: number; duration: number }>();

		// Initialize all cells
		for (let day = 0; day < 7; day++) {
			for (let hour = 0; hour < 24; hour++) {
				data.set(`${day}-${hour}`, { count: 0, duration: 0 });
			}
		}

		// Populate with data
		for (const conv of convs) {
			const convDate = new Date(conv.startedAt || conv.date + 'T' + this.convertTo24Hour(conv.time));
			const day = convDate.getDay();
			const hour = convDate.getHours();
			const key = `${day}-${hour}`;
			const cell = data.get(key)!;
			cell.count++;
			cell.duration += conv.duration || 0;
		}

		// Find max for normalization
		const maxCount = Math.max(...Array.from(data.values()).map(d => d.count), 1);

		// Convert to array
		for (let day = 0; day < 7; day++) {
			for (let hour = 0; hour < 24; hour++) {
				const cell = data.get(`${day}-${hour}`)!;
				cells.push({
					day,
					hour,
					count: cell.count,
					duration: cell.duration,
					intensity: cell.count / maxCount
				});
			}
		}

		return cells;
	}

	private findPeakTime(heatmap: HeatmapCell[]): { peakDay: string; peakHour: string } {
		const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
		let maxCell = heatmap[0];

		for (const cell of heatmap) {
			if (cell.count > maxCell.count) {
				maxCell = cell;
			}
		}

		const hourStr = maxCell.hour === 0 ? '12am' :
			maxCell.hour < 12 ? `${maxCell.hour}am` :
				maxCell.hour === 12 ? '12pm' :
					`${maxCell.hour - 12}pm`;

		return {
			peakDay: dayNames[maxCell.day],
			peakHour: hourStr
		};
	}

	private computeStreak(convs: SyncedConversationMeta[]): number {
		if (convs.length === 0) return 0;

		// Get unique dates sorted descending
		const dates = [...new Set(convs.map(c => c.date))].sort().reverse();
		if (dates.length === 0) return 0;

		const today = this.formatDateOnly(new Date());
		const yesterday = this.formatDateOnly(new Date(Date.now() - 24 * 60 * 60 * 1000));

		// Start from today or yesterday
		let streak = 0;
		let currentDate = dates[0] === today || dates[0] === yesterday ? new Date(dates[0] + 'T00:00:00') : null;

		if (!currentDate) return 0;

		const dateSet = new Set(dates);

		while (dateSet.has(this.formatDateOnly(currentDate))) {
			streak++;
			currentDate = new Date(currentDate.getTime() - 24 * 60 * 60 * 1000);
		}

		return streak;
	}

	private computeCategoryStats(convs: SyncedConversationMeta[], totalDuration: number, prevConvs: SyncedConversationMeta[] = []): CategoryStat[] {
		const categoryData = new Map<string, { count: number; duration: number }>();

		for (const conv of convs) {
			const cat = conv.category || 'other';
			const data = categoryData.get(cat) || { count: 0, duration: 0 };
			data.count++;
			data.duration += conv.duration || 0;
			categoryData.set(cat, data);
		}

		// Compute previous period category data for trends
		const prevCategoryData = new Map<string, { count: number; duration: number }>();
		for (const conv of prevConvs) {
			const cat = conv.category || 'other';
			const data = prevCategoryData.get(cat) || { count: 0, duration: 0 };
			data.count++;
			data.duration += conv.duration || 0;
			prevCategoryData.set(cat, data);
		}

		return Array.from(categoryData.entries())
			.map(([category, data]) => {
				const prevData = prevCategoryData.get(category);
				const durationTrend = prevData && prevData.duration > 0
					? ((data.duration - prevData.duration) / prevData.duration) * 100
					: undefined;
				const countTrend = prevData && prevData.count > 0
					? ((data.count - prevData.count) / prevData.count) * 100
					: undefined;

				return {
					category,
					count: data.count,
					duration: data.duration,
					percentage: totalDuration > 0 ? (data.duration / totalDuration) * 100 : 0,
					durationTrend,
					countTrend
				};
			})
			.sort((a, b) => b.duration - a.duration);
	}

	private computeDurationDistribution(convs: SyncedConversationMeta[]): DurationBucket[] {
		const buckets: DurationBucket[] = [
			{ label: 'Quick', min: 0, max: 5, count: 0, percentage: 0 },
			{ label: 'Short', min: 5, max: 15, count: 0, percentage: 0 },
			{ label: 'Medium', min: 15, max: 30, count: 0, percentage: 0 },
			{ label: 'Long', min: 30, max: 60, count: 0, percentage: 0 },
			{ label: 'Extended', min: 60, max: Infinity, count: 0, percentage: 0 }
		];

		for (const conv of convs) {
			const duration = conv.duration || 0;
			for (const bucket of buckets) {
				if (duration >= bucket.min && duration < bucket.max) {
					bucket.count++;
					break;
				}
			}
		}

		const total = convs.length || 1;
		for (const bucket of buckets) {
			bucket.percentage = (bucket.count / total) * 100;
		}

		return buckets;
	}

	private computeMemoryStats(): MemoryStats | null {
		if (this.statsMemories.length === 0) return null;

		const byCategory: Record<string, number> = {};
		const tagCounts: Record<string, number> = {};
		const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

		let recentCount = 0;

		for (const memory of this.statsMemories) {
			// Count by category
			const cat = memory.category || 'other';
			byCategory[cat] = (byCategory[cat] || 0) + 1;

			// Count tags
			for (const tag of memory.tags || []) {
				tagCounts[tag] = (tagCounts[tag] || 0) + 1;
			}

			// Recent count
			if (new Date(memory.created_at) >= sevenDaysAgo) {
				recentCount++;
			}
		}

		// Get top tags
		const topTags = Object.entries(tagCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([tag, count]) => ({ tag, count }));

		return {
			total: this.statsMemories.length,
			byCategory,
			topTags,
			recentCount
		};
	}

	private computeTaskStats(): TaskStats | null {
		if (this.statsTasks.length === 0) return null;

		const now = new Date();
		let completed = 0;
		let pending = 0;
		let overdue = 0;
		let totalCompletionTime = 0;
		let completedWithTime = 0;

		for (const task of this.statsTasks) {
			if (task.completed) {
				completed++;
				if (task.created_at && task.completed_at) {
					const createdAt = new Date(task.created_at);
					const completedAt = new Date(task.completed_at);
					totalCompletionTime += (completedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
					completedWithTime++;
				}
			} else {
				pending++;
				if (task.due_at && new Date(task.due_at) < now) {
					overdue++;
				}
			}
		}

		return {
			total: this.statsTasks.length,
			completed,
			pending,
			overdue,
			completionRate: this.statsTasks.length > 0 ? completed / this.statsTasks.length : 0,
			avgCompletionDays: completedWithTime > 0 ? totalCompletionTime / completedWithTime : null
		};
	}

	private computeLocationStats(convs: SyncedConversationMeta[]): {
		uniqueLocations: number;
		topLocations: { address: string; count: number }[];
		countries: string[];
		states: string[];
		cities: string[];
	} {
		const locationCounts = new Map<string, number>();
		const countriesSet = new Set<string>();
		const statesSet = new Set<string>();
		const citiesSet = new Set<string>();

		for (const conv of convs) {
			if (conv.geolocation?.address) {
				const addr = conv.geolocation.address;
				locationCounts.set(addr, (locationCounts.get(addr) || 0) + 1);

				// Parse address components (format: "Street, City, State ZIP, Country")
				const parts = addr.split(',').map(p => p.trim());
				if (parts.length >= 2) {
					// Country is usually last
					const country = parts[parts.length - 1];
					if (country && country.length > 1) {
						countriesSet.add(country);
					}

					// State is second to last (may include ZIP)
					if (parts.length >= 3) {
						const stateZip = parts[parts.length - 2];
						// Remove ZIP code if present (e.g., "OR 97124" -> "OR")
						const state = stateZip.replace(/\d+/g, '').trim();
						if (state && state.length > 0) {
							statesSet.add(state);
						}
					}

					// City is third to last (or second if no state)
					if (parts.length >= 3) {
						const city = parts[parts.length - 3];
						if (city && city.length > 1 && !city.match(/^\d/)) {
							citiesSet.add(city);
						}
					} else if (parts.length === 2) {
						// Just "City, Country" format
						const city = parts[0];
						if (city && city.length > 1 && !city.match(/^\d/)) {
							citiesSet.add(city);
						}
					}
				}
			}
		}

		const topLocations = Array.from(locationCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([address, count]) => ({ address, count }));

		return {
			uniqueLocations: locationCounts.size,
			topLocations,
			countries: Array.from(countriesSet),
			states: Array.from(statesSet),
			cities: Array.from(citiesSet)
		};
	}

	private computeAchievements(data: AchievementData): Achievement[] {
		const achievements: Achievement[] = [
			// ==================== CONVERSATION MILESTONES (8) ====================
			{
				id: 'conv_10',
				icon: '💬',
				title: 'First Steps',
				description: 'Record 10 conversations',
				category: 'conversations',
				unlocked: data.conversationCount >= 10,
				threshold: 10,
				current: data.conversationCount,
				progress: Math.min(data.conversationCount / 10, 1)
			},
			{
				id: 'conv_50',
				icon: '🗣️',
				title: 'Getting Started',
				description: 'Record 50 conversations',
				category: 'conversations',
				unlocked: data.conversationCount >= 50,
				threshold: 50,
				current: data.conversationCount,
				progress: Math.min(data.conversationCount / 50, 1)
			},
			{
				id: 'conv_100',
				icon: '💯',
				title: 'Centurion',
				description: 'Record 100 conversations',
				category: 'conversations',
				unlocked: data.conversationCount >= 100,
				threshold: 100,
				current: data.conversationCount,
				progress: Math.min(data.conversationCount / 100, 1)
			},
			{
				id: 'conv_250',
				icon: '🎯',
				title: 'Committed',
				description: 'Record 250 conversations',
				category: 'conversations',
				unlocked: data.conversationCount >= 250,
				threshold: 250,
				current: data.conversationCount,
				progress: Math.min(data.conversationCount / 250, 1)
			},
			{
				id: 'conv_500',
				icon: '🔥',
				title: 'Chatterbox',
				description: 'Record 500 conversations',
				category: 'conversations',
				unlocked: data.conversationCount >= 500,
				threshold: 500,
				current: data.conversationCount,
				progress: Math.min(data.conversationCount / 500, 1)
			},
			{
				id: 'conv_1000',
				icon: '🏆',
				title: 'Conversation Master',
				description: 'Record 1,000 conversations',
				category: 'conversations',
				unlocked: data.conversationCount >= 1000,
				threshold: 1000,
				current: data.conversationCount,
				progress: Math.min(data.conversationCount / 1000, 1)
			},
			{
				id: 'conv_2000',
				icon: '👑',
				title: 'Omi Legend',
				description: 'Record 2,000 conversations',
				category: 'conversations',
				unlocked: data.conversationCount >= 2000,
				threshold: 2000,
				current: data.conversationCount,
				progress: Math.min(data.conversationCount / 2000, 1)
			},
			{
				id: 'conv_5000',
				icon: '⭐',
				title: 'Hall of Fame',
				description: 'Record 5,000 conversations',
				category: 'conversations',
				unlocked: data.conversationCount >= 5000,
				threshold: 5000,
				current: data.conversationCount,
				progress: Math.min(data.conversationCount / 5000, 1)
			},

			// ==================== STREAK ACHIEVEMENTS (6) ====================
			{
				id: 'streak_7',
				icon: '📅',
				title: 'Week Warrior',
				description: '7-day conversation streak',
				category: 'streaks',
				unlocked: data.streak >= 7,
				threshold: 7,
				current: data.streak,
				progress: Math.min(data.streak / 7, 1)
			},
			{
				id: 'streak_14',
				icon: '🔥',
				title: 'Two Week Titan',
				description: '14-day conversation streak',
				category: 'streaks',
				unlocked: data.streak >= 14,
				threshold: 14,
				current: data.streak,
				progress: Math.min(data.streak / 14, 1)
			},
			{
				id: 'streak_30',
				icon: '⚡',
				title: 'Monthly Master',
				description: '30-day conversation streak',
				category: 'streaks',
				unlocked: data.streak >= 30,
				threshold: 30,
				current: data.streak,
				progress: Math.min(data.streak / 30, 1)
			},
			{
				id: 'streak_60',
				icon: '💪',
				title: 'Dedicated',
				description: '60-day conversation streak',
				category: 'streaks',
				unlocked: data.streak >= 60,
				threshold: 60,
				current: data.streak,
				progress: Math.min(data.streak / 60, 1)
			},
			{
				id: 'streak_90',
				icon: '🏅',
				title: 'Unstoppable',
				description: '90-day conversation streak',
				category: 'streaks',
				unlocked: data.streak >= 90,
				threshold: 90,
				current: data.streak,
				progress: Math.min(data.streak / 90, 1)
			},
			{
				id: 'streak_180',
				icon: '🌟',
				title: 'Streak Legend',
				description: '180-day conversation streak',
				category: 'streaks',
				unlocked: data.streak >= 180,
				threshold: 180,
				current: data.streak,
				progress: Math.min(data.streak / 180, 1)
			},

			// ==================== TIME-BASED ACHIEVEMENTS (6) ====================
			{
				id: 'time_night_25',
				icon: '🦉',
				title: 'Night Owl',
				description: '25 late-night conversations (10pm-4am)',
				category: 'time',
				unlocked: data.lateNightCount >= 25,
				threshold: 25,
				current: data.lateNightCount,
				progress: Math.min(data.lateNightCount / 25, 1)
			},
			{
				id: 'time_night_100',
				icon: '🌙',
				title: 'Midnight Master',
				description: '100 late-night conversations',
				category: 'time',
				unlocked: data.lateNightCount >= 100,
				threshold: 100,
				current: data.lateNightCount,
				progress: Math.min(data.lateNightCount / 100, 1)
			},
			{
				id: 'time_early_25',
				icon: '🐦',
				title: 'Early Bird',
				description: '25 early morning conversations (5-8am)',
				category: 'time',
				unlocked: data.earlyMorningCount >= 25,
				threshold: 25,
				current: data.earlyMorningCount,
				progress: Math.min(data.earlyMorningCount / 25, 1)
			},
			{
				id: 'time_early_100',
				icon: '🌅',
				title: 'Dawn Patrol',
				description: '100 early morning conversations',
				category: 'time',
				unlocked: data.earlyMorningCount >= 100,
				threshold: 100,
				current: data.earlyMorningCount,
				progress: Math.min(data.earlyMorningCount / 100, 1)
			},
			{
				id: 'time_marathon',
				icon: '⏱️',
				title: 'Marathon Talker',
				description: 'Single conversation over 60 minutes',
				category: 'time',
				unlocked: data.conversationsOver60Min >= 1,
				threshold: 1,
				current: data.conversationsOver60Min,
				progress: Math.min(data.conversationsOver60Min / 1, 1)
			},
			{
				id: 'time_podcast',
				icon: '🎙️',
				title: 'Podcast Pro',
				description: '10 conversations over 30 minutes',
				category: 'time',
				unlocked: data.conversationsOver30Min >= 10,
				threshold: 10,
				current: data.conversationsOver30Min,
				progress: Math.min(data.conversationsOver30Min / 10, 1)
			},

			// ==================== LOCATION ACHIEVEMENTS (4) ====================
			{
				id: 'loc_5',
				icon: '📍',
				title: 'Explorer',
				description: 'Visit 5 unique locations',
				category: 'location',
				unlocked: data.uniqueLocations >= 5,
				threshold: 5,
				current: data.uniqueLocations,
				progress: Math.min(data.uniqueLocations / 5, 1)
			},
			{
				id: 'loc_10',
				icon: '🌍',
				title: 'Globe Trotter',
				description: 'Visit 10 unique locations',
				category: 'location',
				unlocked: data.uniqueLocations >= 10,
				threshold: 10,
				current: data.uniqueLocations,
				progress: Math.min(data.uniqueLocations / 10, 1)
			},
			{
				id: 'loc_25',
				icon: '✈️',
				title: 'World Traveler',
				description: 'Visit 25 unique locations',
				category: 'location',
				unlocked: data.uniqueLocations >= 25,
				threshold: 25,
				current: data.uniqueLocations,
				progress: Math.min(data.uniqueLocations / 25, 1)
			},
			{
				id: 'loc_50',
				icon: '🗺️',
				title: 'Cartographer',
				description: 'Visit 50 unique locations',
				category: 'location',
				unlocked: data.uniqueLocations >= 50,
				threshold: 50,
				current: data.uniqueLocations,
				progress: Math.min(data.uniqueLocations / 50, 1)
			},

			// ==================== MEMORY ACHIEVEMENTS (4) ====================
			{
				id: 'mem_25',
				icon: '💡',
				title: 'Memory Starter',
				description: 'Collect 25 memories',
				category: 'memory',
				unlocked: data.memoryCount >= 25,
				threshold: 25,
				current: data.memoryCount,
				progress: Math.min(data.memoryCount / 25, 1)
			},
			{
				id: 'mem_100',
				icon: '🧠',
				title: 'Memory Builder',
				description: 'Collect 100 memories',
				category: 'memory',
				unlocked: data.memoryCount >= 100,
				threshold: 100,
				current: data.memoryCount,
				progress: Math.min(data.memoryCount / 100, 1)
			},
			{
				id: 'mem_250',
				icon: '📚',
				title: 'Knowledge Vault',
				description: 'Collect 250 memories',
				category: 'memory',
				unlocked: data.memoryCount >= 250,
				threshold: 250,
				current: data.memoryCount,
				progress: Math.min(data.memoryCount / 250, 1)
			},
			{
				id: 'mem_500',
				icon: '🏛️',
				title: 'Memory Palace',
				description: 'Collect 500 memories',
				category: 'memory',
				unlocked: data.memoryCount >= 500,
				threshold: 500,
				current: data.memoryCount,
				progress: Math.min(data.memoryCount / 500, 1)
			},

			// ==================== TASK ACHIEVEMENTS (4) ====================
			{
				id: 'task_10',
				icon: '✅',
				title: 'Task Starter',
				description: 'Complete 10 tasks',
				category: 'task',
				unlocked: data.completedTasksCount >= 10,
				threshold: 10,
				current: data.completedTasksCount,
				progress: Math.min(data.completedTasksCount / 10, 1)
			},
			{
				id: 'task_50',
				icon: '⚡',
				title: 'Task Crusher',
				description: 'Complete 50 tasks',
				category: 'task',
				unlocked: data.completedTasksCount >= 50,
				threshold: 50,
				current: data.completedTasksCount,
				progress: Math.min(data.completedTasksCount / 50, 1)
			},
			{
				id: 'task_100',
				icon: '🎯',
				title: 'Productivity Pro',
				description: 'Complete 100 tasks',
				category: 'task',
				unlocked: data.completedTasksCount >= 100,
				threshold: 100,
				current: data.completedTasksCount,
				progress: Math.min(data.completedTasksCount / 100, 1)
			},
			{
				id: 'task_250',
				icon: '🏆',
				title: 'Task Master',
				description: 'Complete 250 tasks',
				category: 'task',
				unlocked: data.completedTasksCount >= 250,
				threshold: 250,
				current: data.completedTasksCount,
				progress: Math.min(data.completedTasksCount / 250, 1)
			},

			// ==================== SPECIAL ACHIEVEMENTS (4) ====================
			{
				id: 'special_anniversary',
				icon: '🎂',
				title: 'Anniversary',
				description: 'Use Omi for 1 year',
				category: 'special',
				unlocked: data.daysSinceFirstConversation >= 365,
				threshold: 365,
				current: data.daysSinceFirstConversation,
				progress: Math.min(data.daysSinceFirstConversation / 365, 1)
			},
			{
				id: 'special_categories',
				icon: '🌈',
				title: 'Category Explorer',
				description: 'Have conversations in 5+ categories',
				category: 'special',
				unlocked: data.uniqueCategories >= 5,
				threshold: 5,
				current: data.uniqueCategories,
				progress: Math.min(data.uniqueCategories / 5, 1)
			},
			{
				id: 'special_hours_100',
				icon: '📊',
				title: 'Data Enthusiast',
				description: 'Record 100+ hours of conversations',
				category: 'special',
				unlocked: data.totalHoursRecorded >= 100,
				threshold: 100,
				current: Math.round(data.totalHoursRecorded),
				progress: Math.min(data.totalHoursRecorded / 100, 1)
			},
			{
				id: 'special_hours_500',
				icon: '🎬',
				title: 'Recording Pro',
				description: 'Record 500+ hours of conversations',
				category: 'special',
				unlocked: data.totalHoursRecorded >= 500,
				threshold: 500,
				current: Math.round(data.totalHoursRecorded),
				progress: Math.min(data.totalHoursRecorded / 500, 1)
			}
		];

		return achievements;
	}

	// Helper methods for achievement data computation
	private getLongestConversationMinutes(convs: SyncedConversationMeta[]): number {
		if (convs.length === 0) return 0;
		return Math.max(...convs.map(c => c.duration || 0));
	}

	private countConversationsOverMinutes(convs: SyncedConversationMeta[], minutes: number): number {
		return convs.filter(c => (c.duration || 0) >= minutes).length;
	}

	private countUniqueCategories(convs: SyncedConversationMeta[]): number {
		const categories = new Set<string>();
		for (const c of convs) {
			if (c.category) {
				categories.add(c.category);
			}
		}
		return categories.size;
	}

	private getDaysSinceFirstConversation(convs: SyncedConversationMeta[]): number {
		if (convs.length === 0) return 0;

		// Find the earliest conversation date
		let earliestDate: Date | null = null;
		for (const c of convs) {
			const convDate = new Date(c.startedAt || c.date);
			if (!earliestDate || convDate < earliestDate) {
				earliestDate = convDate;
			}
		}

		if (!earliestDate) return 0;

		const now = new Date();
		const diffTime = Math.abs(now.getTime() - earliestDate.getTime());
		const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
		return diffDays;
	}

	private parseTimeToHour(timeStr: string): number {
		const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
		if (!match) return 0;

		let hour = parseInt(match[1]);
		const isPM = match[3]?.toUpperCase() === 'PM';
		const isAM = match[3]?.toUpperCase() === 'AM';

		if (isPM && hour !== 12) hour += 12;
		if (isAM && hour === 12) hour = 0;

		return hour;
	}

	private convertTo24Hour(timeStr: string): string {
		const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
		if (!match) return '00:00:00';

		let hour = parseInt(match[1]);
		const minute = match[2];
		const isPM = match[3]?.toUpperCase() === 'PM';
		const isAM = match[3]?.toUpperCase() === 'AM';

		if (isPM && hour !== 12) hour += 12;
		if (isAM && hour === 12) hour = 0;

		return `${hour.toString().padStart(2, '0')}:${minute}:00`;
	}

	// ==================== STATS TILE RENDERERS ====================

	private renderInsightsBanner(container: HTMLElement, stats: StatsData): void {
		const banner = container.createDiv('omi-stats-insights-banner');

		// Build insight text
		const insights: string[] = [];

		// Streak insight
		if (stats.streak > 0) {
			insights.push(`🔥 ${stats.streak}-day streak!`);
		}

		// Conversation trend
		if (stats.conversationTrend !== 0 && this.statsTimeRange !== 'all') {
			const direction = stats.conversationTrend > 0 ? 'up' : 'down';
			const arrow = stats.conversationTrend > 0 ? '↑' : '↓';
			insights.push(`${arrow} ${Math.abs(Math.round(stats.conversationTrend))}% ${direction} from last period`);
		}

		// Peak time
		if (stats.conversationCount > 0) {
			insights.push(`Peak: ${stats.peakDay} ${stats.peakHour}`);
		}

		// Unlocked achievements
		const newAchievements = stats.achievements.filter(a => a.unlocked);
		if (newAchievements.length > 0) {
			const latest = newAchievements[newAchievements.length - 1];
			insights.push(`${latest.icon} ${latest.title} unlocked!`);
		}

		const text = insights.length > 0
			? insights.join(' • ')
			: `${stats.conversationCount} conversations tracked`;

		banner.createEl('span', { text, cls: 'omi-insights-text' });
	}

	private renderConversationsKPITile(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-kpi-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '💬', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Conversations', cls: 'omi-stats-tile-title' });

		const value = tile.createDiv('omi-stats-kpi-value');
		value.createEl('span', { text: stats.conversationCount.toLocaleString(), cls: 'omi-stats-big-number' });

		// Sparkline
		this.renderSparkline(tile, stats.weeklyConversations, 'var(--omi-accent)');

		// Trend
		if (stats.conversationTrend !== 0 && this.statsTimeRange !== 'all') {
			const trendClass = stats.conversationTrend > 0 ? 'positive' : 'negative';
			const arrow = stats.conversationTrend > 0 ? '↑' : '↓';
			tile.createEl('span', {
				text: `${arrow} ${Math.abs(Math.round(stats.conversationTrend))}%`,
				cls: `omi-stats-trend ${trendClass}`
			});
		}
	}

	private renderTimeRecordedKPITile(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-kpi-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '⏱️', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Time Recorded', cls: 'omi-stats-tile-title' });

		const value = tile.createDiv('omi-stats-kpi-value');
		value.createEl('span', { text: this.formatDuration(stats.totalDuration), cls: 'omi-stats-big-number' });

		// Sparkline
		this.renderSparkline(tile, stats.weeklyDuration, 'var(--omi-accent)');

		// Trend
		if (stats.durationTrend !== 0 && this.statsTimeRange !== 'all') {
			const trendClass = stats.durationTrend > 0 ? 'positive' : 'negative';
			const arrow = stats.durationTrend > 0 ? '↑' : '↓';
			tile.createEl('span', {
				text: `${arrow} ${Math.abs(Math.round(stats.durationTrend))}%`,
				cls: `omi-stats-trend ${trendClass}`
			});
		}

		// Average
		tile.createEl('span', {
			text: `Avg: ${Math.round(stats.avgDuration)} min`,
			cls: 'omi-stats-subtitle'
		});
	}

	private renderAchievementsTile(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-achievements-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '🏆', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Achievements', cls: 'omi-stats-tile-title' });

		// Eye icon to view all achievements
		const viewBtn = header.createEl('button', {
			cls: 'omi-stats-view-btn clickable-icon',
			attr: { 'aria-label': 'View all achievements' }
		});
		setIcon(viewBtn, 'eye');
		viewBtn.addEventListener('click', () => {
			new AchievementsModal(this.app, stats.achievements).open();
		});

		const unlocked = stats.achievements.filter(a => a.unlocked).length;
		const total = stats.achievements.length;

		const progressText = tile.createDiv('omi-stats-achievements-progress');
		progressText.createEl('span', { text: `${unlocked}/${total}`, cls: 'omi-stats-big-number' });

		// Progress bar
		const progressBar = tile.createDiv('omi-stats-progress-bar');
		const fill = progressBar.createDiv('omi-stats-progress-fill');
		fill.style.width = `${(unlocked / total) * 100}%`;

		// Show badges
		const badges = tile.createDiv('omi-stats-achievement-badges');
		for (const achievement of stats.achievements) {
			const badge = badges.createEl('span', {
				text: achievement.icon,
				cls: `omi-stats-badge ${achievement.unlocked ? 'unlocked' : 'locked'}`,
				title: `${achievement.title}\n${achievement.description}\n${achievement.unlocked ? 'Unlocked!' : `Progress: ${achievement.current}/${achievement.threshold}`}`
			});

			// Partial progress ring for locked badges
			if (!achievement.unlocked && achievement.progress && achievement.progress > 0) {
				badge.style.setProperty('--progress', `${achievement.progress * 100}%`);
				badge.addClass('has-progress');
			}
		}
	}

	private renderTimePatternHeatmap(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-heatmap-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '📅', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Time Patterns', cls: 'omi-stats-tile-title' });

		const peakInfo = header.createEl('span', {
			text: `Peak: ${stats.peakDay} ${stats.peakHour}`,
			cls: 'omi-stats-peak-info'
		});

		const heatmapGrid = tile.createDiv('omi-stats-hour-day-heatmap');

		// Day labels (column headers)
		const dayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
		const dayRow = heatmapGrid.createDiv('omi-stats-hm-row omi-stats-hm-header');
		for (const day of dayNames) {
			dayRow.createEl('span', { text: day, cls: 'omi-stats-hm-label' });
		}

		// Hour rows (6am to 11pm, grouped by 3 hours)
		const hourLabels = ['6am', '9am', '12pm', '3pm', '6pm', '9pm'];
		const hourRanges = [[6, 7, 8], [9, 10, 11], [12, 13, 14], [15, 16, 17], [18, 19, 20], [21, 22, 23]];

		for (let i = 0; i < hourLabels.length; i++) {
			const row = heatmapGrid.createDiv('omi-stats-hm-row');
			row.createEl('span', { text: hourLabels[i], cls: 'omi-stats-hm-label' });

			// Days 1-7 (Mon-Sun, reordered from Sun=0)
			const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon to Sun
			for (const dayIdx of dayOrder) {
				// Aggregate cells for this time block
				let count = 0;
				let duration = 0;
				let maxIntensity = 0;

				for (const hour of hourRanges[i]) {
					const cell = stats.heatmap.find(c => c.day === dayIdx && c.hour === hour);
					if (cell) {
						count += cell.count;
						duration += cell.duration;
						maxIntensity = Math.max(maxIntensity, cell.intensity);
					}
				}

				const cellEl = row.createDiv('omi-stats-hm-cell');

				// Set intensity level (0-4)
				const level = maxIntensity === 0 ? 0 :
					maxIntensity < 0.25 ? 1 :
						maxIntensity < 0.5 ? 2 :
							maxIntensity < 0.75 ? 3 : 4;

				cellEl.addClass(`omi-stats-hm-level-${level}`);
				cellEl.setAttribute('title', `${count} conversations\n${this.formatDuration(duration, true)}`);

				// Click to filter by this time slot
				if (count > 0) {
					cellEl.addClass('clickable');
					const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dayIdx];
					cellEl.addEventListener('click', () => {
						new Notice(`${count} conversations on ${dayName}s ${hourLabels[i]}-${i < hourLabels.length - 1 ? hourLabels[i + 1] : '12am'}`);
					});
				}
			}
		}
	}

	// ==================== EXPERIMENTAL VISUALIZATIONS ====================

	private renderInsightsSummary(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-insights-tile');

		// Header with period indicator
		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '💡', cls: 'omi-stats-tile-icon' });
		const titleText = this.getHighlightsTitle();
		header.createEl('span', { text: titleText, cls: 'omi-stats-tile-title' });

		// KPI row - 4 mini stats
		const kpiRow = tile.createDiv('omi-insights-kpi-row');

		// Conversations
		const kpi1 = kpiRow.createDiv('omi-insights-kpi');
		kpi1.createEl('div', { text: String(stats.conversationCount), cls: 'omi-insights-kpi-value' });
		kpi1.createEl('div', { text: 'convos', cls: 'omi-insights-kpi-label' });
		if (stats.conversationTrend !== 0) {
			const trend1 = kpi1.createDiv('omi-insights-kpi-trend');
			trend1.addClass(stats.conversationTrend > 0 ? 'positive' : 'negative');
			trend1.setText(`${stats.conversationTrend > 0 ? '↑' : '↓'}${Math.abs(Math.round(stats.conversationTrend))}%`);
		}

		// Time recorded
		const kpi2 = kpiRow.createDiv('omi-insights-kpi');
		kpi2.createEl('div', { text: this.formatDuration(stats.totalDuration), cls: 'omi-insights-kpi-value' });
		kpi2.createEl('div', { text: 'recorded', cls: 'omi-insights-kpi-label' });
		if (stats.durationTrend !== 0) {
			const trend2 = kpi2.createDiv('omi-insights-kpi-trend');
			trend2.addClass(stats.durationTrend > 0 ? 'positive' : 'negative');
			trend2.setText(`${stats.durationTrend > 0 ? '↑' : '↓'}${Math.abs(Math.round(stats.durationTrend))}%`);
		}

		// Tasks done
		const tasksCompleted = stats.taskStats?.completed || 0;
		const kpi3 = kpiRow.createDiv('omi-insights-kpi');
		kpi3.createEl('div', { text: String(tasksCompleted), cls: 'omi-insights-kpi-value' });
		kpi3.createEl('div', { text: 'tasks done', cls: 'omi-insights-kpi-label' });

		// Streak
		const kpi4 = kpiRow.createDiv('omi-insights-kpi');
		kpi4.createEl('div', { text: stats.streak > 0 ? `${stats.streak}🔥` : '0', cls: 'omi-insights-kpi-value' });
		kpi4.createEl('div', { text: 'day streak', cls: 'omi-insights-kpi-label' });

		const content = tile.createDiv('omi-stats-insights-content');

		// Calculate day totals
		const dayTotals: { day: number; name: string; count: number }[] = [];
		const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
		for (let d = 0; d < 7; d++) {
			const dayCount = stats.heatmap.filter(c => c.day === d).reduce((sum, c) => sum + c.count, 0);
			dayTotals.push({ day: d, name: dayNames[d], count: dayCount });
		}
		dayTotals.sort((a, b) => b.count - a.count);

		const busiestDay = dayTotals[0];
		const quietestDay = dayTotals[dayTotals.length - 1];
		const avgDaily = dayTotals.reduce((sum, d) => sum + d.count, 0) / 7;

		// Calculate time of day patterns
		const morningCount = stats.heatmap.filter(c => c.hour >= 6 && c.hour < 12).reduce((sum, c) => sum + c.count, 0);
		const afternoonCount = stats.heatmap.filter(c => c.hour >= 12 && c.hour < 18).reduce((sum, c) => sum + c.count, 0);
		const eveningCount = stats.heatmap.filter(c => c.hour >= 18 && c.hour < 24).reduce((sum, c) => sum + c.count, 0);
		const nightCount = stats.heatmap.filter(c => c.hour >= 0 && c.hour < 6).reduce((sum, c) => sum + c.count, 0);

		const timeSlots = [
			{ name: 'mornings', count: morningCount },
			{ name: 'afternoons', count: afternoonCount },
			{ name: 'evenings', count: eveningCount },
			{ name: 'late nights', count: nightCount }
		].sort((a, b) => b.count - a.count);

		// Weekend vs weekday
		const weekdayCount = dayTotals.filter(d => d.day >= 1 && d.day <= 5).reduce((sum, d) => sum + d.count, 0);
		const weekendCount = dayTotals.filter(d => d.day === 0 || d.day === 6).reduce((sum, d) => sum + d.count, 0);
		const weekdayAvg = weekdayCount / 5;
		const weekendAvg = weekendCount / 2;

		// Calculate category peak times from conversation data
		const conversations = Object.values(this.plugin.settings.syncedConversations || {}) as SyncedConversationMeta[];
		const categoryTimeData = new Map<string, { morning: number; afternoon: number; evening: number; night: number; total: number }>();

		for (const conv of conversations) {
			const cat = conv.category || 'other';
			const hour = new Date(conv.startedAt).getHours();

			if (!categoryTimeData.has(cat)) {
				categoryTimeData.set(cat, { morning: 0, afternoon: 0, evening: 0, night: 0, total: 0 });
			}
			const data = categoryTimeData.get(cat)!;
			data.total++;

			if (hour >= 6 && hour < 12) data.morning++;
			else if (hour >= 12 && hour < 18) data.afternoon++;
			else if (hour >= 18 && hour < 24) data.evening++;
			else data.night++;
		}

		// Get top 3 categories and their peak times
		const categoryPeaks = Array.from(categoryTimeData.entries())
			.sort((a, b) => b[1].total - a[1].total)
			.slice(0, 3)
			.map(([cat, data]) => {
				const times = [
					{ name: 'mornings', count: data.morning },
					{ name: 'afternoons', count: data.afternoon },
					{ name: 'evenings', count: data.evening },
					{ name: 'late night', count: data.night }
				];
				const peak = times.sort((a, b) => b.count - a.count)[0];
				return { category: cat, peakTime: peak.name, count: data.total };
			});

		// Build all insights as an array for rotation
		const allInsights: string[] = [];

		// Main insight - busiest day
		const busiestMultiplier = avgDaily > 0 ? (busiestDay.count / avgDaily).toFixed(1) : '1.0';
		allInsights.push(`You're most active on <strong>${busiestDay.name}s</strong> (${busiestMultiplier}x average), especially during <strong>${timeSlots[0].name}</strong>.`);

		// Weekend/weekday insight
		if (weekendAvg < weekdayAvg * 0.7) {
			const pctLess = Math.round((1 - weekendAvg / weekdayAvg) * 100);
			allInsights.push(`Weekends are <strong>${pctLess}% quieter</strong> than weekdays.`);
		} else if (weekendAvg > weekdayAvg * 1.3) {
			const pctMore = Math.round((weekendAvg / weekdayAvg - 1) * 100);
			allInsights.push(`Weekends are <strong>${pctMore}% busier</strong> than weekdays.`);
		} else {
			allInsights.push(`Your activity is <strong>consistent</strong> throughout the week.`);
		}

		// Category peak times
		if (categoryPeaks.length > 0) {
			const topCat = categoryPeaks[0];
			let catInsight = `<strong>${topCat.category}</strong> peaks in <strong>${topCat.peakTime}</strong>`;
			if (categoryPeaks.length > 1) {
				catInsight += `, <strong>${categoryPeaks[1].category}</strong> in <strong>${categoryPeaks[1].peakTime}</strong>`;
			}
			allInsights.push(catInsight + '.');
		}

		// Peak time insight
		if (stats.peakHour) {
			allInsights.push(`Peak activity time: <strong>${stats.peakHour}</strong>`);
		}

		// Top category
		if (stats.topCategory && stats.topCategory !== 'Unknown') {
			allInsights.push(`Top category: <strong>${stats.topCategory}</strong>`);
		}

		// Memory insight
		if (stats.memoryStats && stats.memoryStats.recentCount > 0) {
			allInsights.push(`<strong>${stats.memoryStats.recentCount}</strong> new memories this week`);
		}

		// Task completion rate
		if (stats.taskStats && stats.taskStats.completed > 0) {
			const rate = Math.round(stats.taskStats.completionRate * 100);
			allInsights.push(`Task completion rate: <strong>${rate}%</strong>`);
		}

		// Quietest time
		allInsights.push(`Quietest: <strong>${quietestDay.name}s</strong> and <strong>${timeSlots[timeSlots.length - 1].name}</strong>`);

		// Display all insights at once
		const insightsContainer = content.createDiv('omi-insights-list');
		for (const insight of allInsights) {
			const p = insightsContainer.createEl('p', { cls: 'omi-insight-item' });
			p.innerHTML = insight;
		}
	}

	private renderRadialClock(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-radial-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '🕐', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Activity Clock', cls: 'omi-stats-tile-title' });

		const clockContainer = tile.createDiv('omi-stats-radial-container');

		// SVG setup
		const size = 280;
		const center = size / 2;
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
		svg.setAttribute('class', 'omi-radial-clock');

		// Find max count for normalization
		const maxCount = Math.max(...stats.heatmap.map(c => c.count), 1);

		// Draw 7 concentric rings (one per day, Mon-Sun from inner to outer)
		const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun
		const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		const ringWidth = 16;
		const innerRadius = 35;

		for (let ringIdx = 0; ringIdx < 7; ringIdx++) {
			const dayIdx = dayOrder[ringIdx];
			const radius = innerRadius + ringIdx * ringWidth;

			// Draw 24 segments for each hour
			for (let hour = 0; hour < 24; hour++) {
				const cell = stats.heatmap.find(c => c.day === dayIdx && c.hour === hour);
				const count = cell?.count || 0;
				const intensity = count / maxCount;

				// Calculate arc angles (0 = top, clockwise)
				const startAngle = (hour / 24) * 2 * Math.PI - Math.PI / 2;
				const endAngle = ((hour + 1) / 24) * 2 * Math.PI - Math.PI / 2;

				const x1 = center + radius * Math.cos(startAngle);
				const y1 = center + radius * Math.sin(startAngle);
				const x2 = center + radius * Math.cos(endAngle);
				const y2 = center + radius * Math.sin(endAngle);
				const x3 = center + (radius + ringWidth - 2) * Math.cos(endAngle);
				const y3 = center + (radius + ringWidth - 2) * Math.sin(endAngle);
				const x4 = center + (radius + ringWidth - 2) * Math.cos(startAngle);
				const y4 = center + (radius + ringWidth - 2) * Math.sin(startAngle);

				const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				const d = `M ${x1} ${y1} A ${radius} ${radius} 0 0 1 ${x2} ${y2} L ${x3} ${y3} A ${radius + ringWidth - 2} ${radius + ringWidth - 2} 0 0 0 ${x4} ${y4} Z`;
				path.setAttribute('d', d);

				// Color based on intensity
				const alpha = intensity === 0 ? 0.08 : 0.2 + intensity * 0.8;
				path.setAttribute('fill', `rgba(139, 92, 246, ${alpha})`);
				path.setAttribute('stroke', 'rgba(255,255,255,0.3)');
				path.setAttribute('stroke-width', '0.5');

				// Tooltip
				const hourLabel = hour === 0 ? '12am' : hour < 12 ? `${hour}am` : hour === 12 ? '12pm' : `${hour - 12}pm`;
				const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
				title.textContent = `${dayNames[dayIdx]} ${hourLabel}: ${count} conversations`;
				path.appendChild(title);

				svg.appendChild(path);
			}
		}

		// Hour labels around the edge
		for (let hour = 0; hour < 24; hour += 3) {
			const angle = (hour / 24) * 2 * Math.PI - Math.PI / 2;
			const labelRadius = center - 8;
			const x = center + labelRadius * Math.cos(angle);
			const y = center + labelRadius * Math.sin(angle);

			const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			text.setAttribute('x', String(x));
			text.setAttribute('y', String(y));
			text.setAttribute('text-anchor', 'middle');
			text.setAttribute('dominant-baseline', 'middle');
			text.setAttribute('class', 'omi-radial-hour-label');
			const hourLabel = hour === 0 ? '12a' : hour < 12 ? `${hour}a` : hour === 12 ? '12p' : `${hour - 12}p`;
			text.textContent = hourLabel;
			svg.appendChild(text);
		}

		// Center label
		const centerText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		centerText.setAttribute('x', String(center));
		centerText.setAttribute('y', String(center));
		centerText.setAttribute('text-anchor', 'middle');
		centerText.setAttribute('dominant-baseline', 'middle');
		centerText.setAttribute('class', 'omi-radial-center-label');
		centerText.textContent = stats.peakHour;
		svg.appendChild(centerText);

		clockContainer.appendChild(svg);

		// Legend
		const legend = tile.createDiv('omi-radial-legend');
		legend.innerHTML = '<span>Inner → Outer: Mon → Sun</span>';
	}

	private renderRidgePlot(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-ridge-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '📈', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Daily Rhythms', cls: 'omi-stats-tile-title' });

		const plotContainer = tile.createDiv('omi-stats-ridge-container');

		const width = 320;
		const height = 220;
		const rowHeight = 28;
		const leftPadding = 40;

		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
		svg.setAttribute('class', 'omi-ridge-plot');

		// Find max count for normalization
		const maxCount = Math.max(...stats.heatmap.map(c => c.count), 1);

		const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun
		const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

		// Draw each day as a ridge line
		dayOrder.forEach((dayIdx, rowIdx) => {
			const baseY = 20 + rowIdx * rowHeight;

			// Get hourly data for this day
			const hourlyData: number[] = [];
			for (let hour = 0; hour < 24; hour++) {
				const cell = stats.heatmap.find(c => c.day === dayIdx && c.hour === hour);
				hourlyData.push(cell?.count || 0);
			}

			// Create smooth path
			const points: string[] = [];
			const xScale = (width - leftPadding - 10) / 23;

			for (let hour = 0; hour < 24; hour++) {
				const x = leftPadding + hour * xScale;
				const normalizedHeight = (hourlyData[hour] / maxCount) * (rowHeight * 0.8);
				const y = baseY - normalizedHeight;
				points.push(`${hour === 0 ? 'M' : 'L'} ${x} ${y}`);
			}

			// Close the path for fill
			const fillPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			const closedPath = points.join(' ') + ` L ${leftPadding + 23 * xScale} ${baseY} L ${leftPadding} ${baseY} Z`;
			fillPath.setAttribute('d', closedPath);
			fillPath.setAttribute('fill', `rgba(139, 92, 246, ${0.3 + rowIdx * 0.08})`);
			fillPath.setAttribute('stroke', 'rgba(139, 92, 246, 0.8)');
			fillPath.setAttribute('stroke-width', '1.5');
			svg.appendChild(fillPath);

			// Day label
			const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			label.setAttribute('x', '5');
			label.setAttribute('y', String(baseY - 2));
			label.setAttribute('class', 'omi-ridge-day-label');
			label.textContent = dayNames[rowIdx];
			svg.appendChild(label);
		});

		// Hour labels at bottom
		const hourLabels = ['12a', '6a', '12p', '6p', '12a'];
		const xScale = (width - leftPadding - 10) / 23;
		hourLabels.forEach((label, i) => {
			const hour = i * 6;
			const x = leftPadding + (hour === 24 ? 23 : hour) * xScale;
			const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			text.setAttribute('x', String(x));
			text.setAttribute('y', String(height - 5));
			text.setAttribute('text-anchor', 'middle');
			text.setAttribute('class', 'omi-ridge-hour-label');
			text.textContent = label;
			svg.appendChild(text);
		});

		plotContainer.appendChild(svg);
	}

	private renderActivityFingerprint(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-fingerprint-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '🔮', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Your Activity Fingerprint', cls: 'omi-stats-tile-title' });

		const fpContainer = tile.createDiv('omi-stats-fingerprint-container');

		const size = 260;
		const center = size / 2;

		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
		svg.setAttribute('class', 'omi-fingerprint');

		// Create 168 data points (7 days × 24 hours) as a spiral
		const maxCount = Math.max(...stats.heatmap.map(c => c.count), 1);

		// Build ordered data: Mon 0h, Mon 1h, ... Sun 23h
		const orderedData: number[] = [];
		const dayOrder = [1, 2, 3, 4, 5, 6, 0];
		for (const dayIdx of dayOrder) {
			for (let hour = 0; hour < 24; hour++) {
				const cell = stats.heatmap.find(c => c.day === dayIdx && c.hour === hour);
				orderedData.push(cell?.count || 0);
			}
		}

		// Draw as polar area / flower petals
		const totalPoints = orderedData.length; // 168
		const baseRadius = 30;
		const maxRadius = 115;

		// Draw filled polygon
		const pathPoints: string[] = [];
		for (let i = 0; i < totalPoints; i++) {
			const angle = (i / totalPoints) * 2 * Math.PI - Math.PI / 2;
			const intensity = orderedData[i] / maxCount;
			const radius = baseRadius + intensity * (maxRadius - baseRadius);

			const x = center + radius * Math.cos(angle);
			const y = center + radius * Math.sin(angle);
			pathPoints.push(`${i === 0 ? 'M' : 'L'} ${x} ${y}`);
		}
		pathPoints.push('Z');

		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', pathPoints.join(' '));
		path.setAttribute('fill', 'rgba(139, 92, 246, 0.3)');
		path.setAttribute('stroke', 'rgba(139, 92, 246, 0.8)');
		path.setAttribute('stroke-width', '1.5');
		svg.appendChild(path);

		// Draw reference circles
		for (const r of [50, 80, 110]) {
			const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			circle.setAttribute('cx', String(center));
			circle.setAttribute('cy', String(center));
			circle.setAttribute('r', String(r));
			circle.setAttribute('fill', 'none');
			circle.setAttribute('stroke', 'rgba(139, 92, 246, 0.15)');
			circle.setAttribute('stroke-width', '1');
			svg.appendChild(circle);
		}

		// Day markers around the edge
		const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
		for (let d = 0; d < 7; d++) {
			const angle = (d * 24 / totalPoints) * 2 * Math.PI - Math.PI / 2;
			const labelRadius = maxRadius + 12;
			const x = center + labelRadius * Math.cos(angle);
			const y = center + labelRadius * Math.sin(angle);

			const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			text.setAttribute('x', String(x));
			text.setAttribute('y', String(y));
			text.setAttribute('text-anchor', 'middle');
			text.setAttribute('dominant-baseline', 'middle');
			text.setAttribute('class', 'omi-fingerprint-day-label');
			text.textContent = dayLabels[d];
			svg.appendChild(text);
		}

		fpContainer.appendChild(svg);

		// Subtitle
		tile.createEl('div', {
			text: 'Your unique weekly activity pattern',
			cls: 'omi-stats-subtitle'
		});
	}

	private renderCategoryTilesGrid(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-categories-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '🏷️', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Categories', cls: 'omi-stats-tile-title' });

		const grid = tile.createDiv('omi-stats-category-grid');

		// Show top 6 categories
		const topCategories = stats.categories.slice(0, 6);

		for (const cat of topCategories) {
			const catTile = grid.createDiv('omi-stats-category-tile clickable');
			catTile.createEl('span', { text: this.getCategoryEmoji(cat.category), cls: 'omi-category-emoji' });
			catTile.createEl('span', { text: cat.category, cls: 'omi-category-name' });
			catTile.createEl('span', { text: this.formatDuration(cat.duration), cls: 'omi-category-duration' });
			catTile.createEl('span', { text: `${cat.count} conv`, cls: 'omi-category-count' });

			// Trend indicators (hours and convos)
			const trendsRow = catTile.createDiv('omi-category-trends');

			// Duration trend
			if (cat.durationTrend !== undefined) {
				const durationTrendEl = trendsRow.createEl('span', { cls: 'omi-category-trend' });
				const arrow = cat.durationTrend >= 0 ? '↑' : '↓';
				durationTrendEl.setText(`${arrow}${Math.abs(Math.round(cat.durationTrend))}% hrs`);
				durationTrendEl.addClass(cat.durationTrend >= 0 ? 'positive' : 'negative');
			}

			// Count trend
			if (cat.countTrend !== undefined) {
				const countTrendEl = trendsRow.createEl('span', { cls: 'omi-category-trend' });
				const arrow = cat.countTrend >= 0 ? '↑' : '↓';
				countTrendEl.setText(`${arrow}${Math.abs(Math.round(cat.countTrend))}% conv`);
				countTrendEl.addClass(cat.countTrend >= 0 ? 'positive' : 'negative');
			}

			// Click to filter
			catTile.addEventListener('click', () => {
				// TODO: Implement category filter navigation
				new Notice(`${cat.category}: ${cat.count} conversations, ${this.formatDuration(cat.duration, true)}`);
			});
		}
	}

	private renderDurationDistributionTile(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-duration-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '📊', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Duration Distribution', cls: 'omi-stats-tile-title' });

		const chart = tile.createDiv('omi-stats-duration-chart');

		for (const bucket of stats.durationBuckets) {
			const row = chart.createDiv('omi-stats-duration-row');
			row.createEl('span', { text: bucket.label, cls: 'omi-duration-label' });

			const barContainer = row.createDiv('omi-duration-bar-container');
			const bar = barContainer.createDiv('omi-duration-bar');
			bar.style.width = `${bucket.percentage}%`;

			row.createEl('span', {
				text: `${Math.round(bucket.percentage)}%`,
				cls: 'omi-duration-percentage'
			});
		}

		// Average duration
		tile.createEl('div', {
			text: `Average: ${Math.round(stats.avgDuration)} min`,
			cls: 'omi-stats-subtitle'
		});
	}

	private renderMemoriesTile(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-memories-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '🧠', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Memories', cls: 'omi-stats-tile-title' });

		if (!stats.memoryStats || stats.memoryStats.total === 0) {
			if (this.isLoadingStats) {
				tile.createEl('div', { text: 'Loading...', cls: 'omi-stats-loading' });
			} else {
				tile.createEl('div', { text: 'No memories synced', cls: 'omi-stats-empty-state' });
				const linkBtn = tile.createEl('button', { text: 'Go to Memories', cls: 'omi-stats-link-btn' });
				linkBtn.addEventListener('click', () => {
					this.activeTab = 'memories';
					this.plugin.settings.activeHubTab = 'memories';
					this.plugin.saveSettings();
					this.loadMemories();
					this.render();
				});
			}
			return;
		}

		const memStats = stats.memoryStats;

		// Total count
		const total = tile.createDiv('omi-stats-memory-total');
		total.createEl('span', { text: memStats.total.toLocaleString(), cls: 'omi-stats-big-number' });
		total.createEl('span', { text: ' memories', cls: 'omi-stats-unit' });

		// Recent indicator
		if (memStats.recentCount > 0) {
			tile.createEl('div', {
				text: `+${memStats.recentCount} this week`,
				cls: 'omi-stats-recent-badge'
			});
		}

		// Category breakdown (top 4)
		const categories = tile.createDiv('omi-stats-memory-categories');
		const sortedCats = Object.entries(memStats.byCategory)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 4);

		for (const [cat, count] of sortedCats) {
			const catRow = categories.createDiv('omi-stats-memory-cat-row');
			const emoji = MEMORY_CATEGORY_EMOJI[cat] || '📌';
			catRow.createEl('span', { text: `${emoji} ${cat}`, cls: 'omi-memory-cat-label' });

			const bar = catRow.createDiv('omi-memory-cat-bar');
			const fill = bar.createDiv('omi-memory-cat-fill');
			fill.style.width = `${(count / memStats.total) * 100}%`;

			catRow.createEl('span', { text: String(count), cls: 'omi-memory-cat-count' });
		}

		// Top tags
		if (memStats.topTags.length > 0) {
			const tagsSection = tile.createDiv('omi-stats-memory-tags');
			tagsSection.createEl('span', { text: 'Top tags:', cls: 'omi-tags-label' });
			const tagsList = tagsSection.createDiv('omi-stats-tags-list');
			for (const { tag, count } of memStats.topTags.slice(0, 6)) {
				const tagEl = tagsList.createEl('span', {
					text: `${tag} (${count})`,
					cls: 'omi-stats-tag clickable'
				});
				tagEl.addEventListener('click', () => {
					// Navigate to memories tab with this tag
					this.activeTab = 'memories';
					this.plugin.settings.activeHubTab = 'memories';
					this.plugin.saveSettings();
					this.selectedTagForDetails = tag;
					this.loadMemories();
					this.render();
				});
			}
		}
	}

	private renderTaskPerformanceTile(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-tasks-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '✅', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Task Performance', cls: 'omi-stats-tile-title' });

		if (!stats.taskStats || stats.taskStats.total === 0) {
			if (this.isLoadingStats) {
				tile.createEl('div', { text: 'Loading...', cls: 'omi-stats-loading' });
			} else {
				tile.createEl('div', { text: 'No tasks synced', cls: 'omi-stats-empty-state' });
				const linkBtn = tile.createEl('button', { text: 'Go to Tasks', cls: 'omi-stats-link-btn' });
				linkBtn.addEventListener('click', () => {
					this.activeTab = 'tasks';
					this.plugin.settings.activeHubTab = 'tasks';
					this.plugin.saveSettings();
					this.loadTasks();
					this.render();
				});
			}
			return;
		}

		const taskStats = stats.taskStats;

		// Completion rate donut
		const rateContainer = tile.createDiv('omi-stats-completion-rate');
		const rate = Math.round(taskStats.completionRate * 100);

		// SVG donut chart
		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('viewBox', '0 0 36 36');
		svg.setAttribute('class', 'omi-stats-donut');

		// Background circle
		const bgCircle = document.createElementNS(svgNS, 'circle');
		bgCircle.setAttribute('cx', '18');
		bgCircle.setAttribute('cy', '18');
		bgCircle.setAttribute('r', '15.915');
		bgCircle.setAttribute('fill', 'none');
		bgCircle.setAttribute('stroke', 'var(--background-modifier-border)');
		bgCircle.setAttribute('stroke-width', '3');
		svg.appendChild(bgCircle);

		// Progress circle
		const progressCircle = document.createElementNS(svgNS, 'circle');
		progressCircle.setAttribute('cx', '18');
		progressCircle.setAttribute('cy', '18');
		progressCircle.setAttribute('r', '15.915');
		progressCircle.setAttribute('fill', 'none');
		progressCircle.setAttribute('stroke', 'var(--omi-status-completed)');
		progressCircle.setAttribute('stroke-width', '3');
		progressCircle.setAttribute('stroke-dasharray', `${rate}, 100`);
		progressCircle.setAttribute('stroke-linecap', 'round');
		progressCircle.setAttribute('transform', 'rotate(-90 18 18)');
		svg.appendChild(progressCircle);

		// Center text
		const text = document.createElementNS(svgNS, 'text');
		text.setAttribute('x', '18');
		text.setAttribute('y', '20.5');
		text.setAttribute('class', 'omi-donut-text');
		text.textContent = `${rate}%`;
		svg.appendChild(text);

		rateContainer.appendChild(svg);
		rateContainer.createEl('span', { text: 'completion', cls: 'omi-rate-label' });

		// Funnel bars
		const funnel = tile.createDiv('omi-stats-task-funnel');

		const rows = [
			{ label: 'Created', count: taskStats.total, color: 'var(--text-muted)' },
			{ label: 'Pending', count: taskStats.pending, color: 'var(--omi-status-pending)' },
			{ label: 'Completed', count: taskStats.completed, color: 'var(--omi-status-completed)' }
		];

		if (taskStats.overdue > 0) {
			rows.splice(2, 0, { label: 'Overdue', count: taskStats.overdue, color: 'var(--omi-status-overdue)' });
		}

		for (const row of rows) {
			const rowEl = funnel.createDiv('omi-stats-funnel-row');
			rowEl.createEl('span', { text: row.label, cls: 'omi-funnel-label' });

			const bar = rowEl.createDiv('omi-funnel-bar');
			const fill = bar.createDiv('omi-funnel-fill');
			fill.style.width = `${(row.count / taskStats.total) * 100}%`;
			fill.style.backgroundColor = row.color;

			rowEl.createEl('span', { text: String(row.count), cls: 'omi-funnel-count' });
		}

		// Avg completion time
		if (taskStats.avgCompletionDays !== null) {
			tile.createEl('div', {
				text: `Avg completion: ${taskStats.avgCompletionDays.toFixed(1)} days`,
				cls: 'omi-stats-subtitle'
			});
		}
	}

	private renderLocationsTile(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-locations-tile');

		const header = tile.createDiv('omi-stats-tile-header');
		header.createEl('span', { text: '📍', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: 'Locations', cls: 'omi-stats-tile-title' });

		// Map icon button to go to full map
		const mapBtn = header.createEl('button', {
			cls: 'omi-stats-view-btn clickable-icon',
			attr: { 'aria-label': 'View full map' }
		});
		setIcon(mapBtn, 'maximize-2');
		mapBtn.addEventListener('click', () => {
			this.activeTab = 'map';
			this.plugin.settings.activeHubTab = 'map';
			this.plugin.saveSettings();
			this.render();
		});

		// Stats row with count
		const statsRow = tile.createDiv('omi-locations-stats-row');
		const countEl = statsRow.createDiv('omi-locations-count');
		countEl.createEl('span', { text: String(stats.uniqueLocations), cls: 'omi-locations-count-value' });
		countEl.createEl('span', { text: 'places', cls: 'omi-locations-count-label' });

		// Mini breakdown
		const breakdown = statsRow.createDiv('omi-locations-breakdown');
		if (stats.countries.length > 0) {
			breakdown.createEl('span', { text: `${stats.countries.length} countries` });
		}
		if (stats.states.length > 0) {
			breakdown.createEl('span', { text: `${stats.states.length} states` });
		}
		if (stats.cities.length > 0) {
			breakdown.createEl('span', { text: `${stats.cities.length} cities` });
		}

		// Mini map container
		const miniMapContainer = tile.createDiv('omi-locations-mini-map');
		const mapEl = miniMapContainer.createDiv('omi-mini-map-leaflet');
		mapEl.id = 'omi-mini-map-' + Date.now();

		// Get conversations with geo data
		const conversationsWithGeo = Object.values(this.plugin.settings.syncedConversations)
			.filter(c => c.geolocation?.latitude && c.geolocation?.longitude) as SyncedConversationMeta[];

		if (conversationsWithGeo.length === 0) {
			miniMapContainer.addClass('omi-mini-map-empty');
			miniMapContainer.empty();
			miniMapContainer.createEl('span', { text: 'No location data', cls: 'omi-mini-map-empty-text' });
			return;
		}

		// Load Leaflet and render mini map
		this.loadLeaflet().then(() => {
			this.initializeMiniMap(mapEl, conversationsWithGeo);
		}).catch(() => {
			miniMapContainer.empty();
			miniMapContainer.createEl('span', { text: 'Map unavailable', cls: 'omi-mini-map-error' });
		});
	}

	private initializeMiniMap(mapEl: HTMLElement, conversations: SyncedConversationMeta[]): void {
		const L = (window as any).L;
		if (!L) return;

		// Calculate bounds
		const validCoords = conversations
			.filter(c => c.geolocation?.latitude && c.geolocation?.longitude)
			.map(c => [c.geolocation!.latitude, c.geolocation!.longitude] as [number, number]);

		if (validCoords.length === 0) return;

		const bounds = L.latLngBounds(validCoords);

		// Create map with minimal controls
		const map = L.map(mapEl, {
			zoomControl: false,
			attributionControl: false,
			dragging: false,
			scrollWheelZoom: false,
			doubleClickZoom: false,
			boxZoom: false,
			keyboard: false,
			touchZoom: false
		});

		// Fit bounds with padding
		map.fitBounds(bounds, { padding: [20, 20], maxZoom: 10 });

		// Use a clean tile layer
		L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
			maxZoom: 19
		}).addTo(map);

		// Group conversations by location for clustering
		const locationGroups = this.groupConversationsByLocation(conversations);

		// Add markers
		for (const [key, convs] of Object.entries(locationGroups)) {
			const [lat, lng] = key.split(',').map(Number);
			const count = convs.length;

			// Create a simple circle marker
			const marker = L.circleMarker([lat, lng], {
				radius: Math.min(4 + Math.log2(count + 1) * 2, 12),
				fillColor: '#8b5cf6',
				color: '#ffffff',
				weight: 1.5,
				opacity: 1,
				fillOpacity: 0.8
			});

			marker.addTo(map);
		}

		// Make the whole tile clickable to go to full map
		mapEl.style.cursor = 'pointer';
		mapEl.addEventListener('click', () => {
			this.activeTab = 'map';
			this.plugin.settings.activeHubTab = 'map';
			this.plugin.saveSettings();
			this.render();
		});
	}

	private renderHighlightsTile(container: HTMLElement, stats: StatsData): void {
		const tile = container.createDiv('omi-stats-tile omi-stats-tile--full omi-highlights-tile');

		// Determine title based on time range
		const titleText = this.getHighlightsTitle();
		const header = tile.createDiv('omi-highlights-header');
		header.createEl('span', { text: '📅', cls: 'omi-stats-tile-icon' });
		header.createEl('span', { text: titleText, cls: 'omi-stats-tile-title' });

		// 4 mini KPI cards
		const kpis = tile.createDiv('omi-highlights-kpis');

		// Conversations this period
		this.renderHighlightKPI(kpis, {
			value: String(stats.conversationCount),
			label: 'convos',
			trend: stats.conversationTrend
		});

		// Time recorded this period
		this.renderHighlightKPI(kpis, {
			value: this.formatDuration(stats.totalDuration),
			label: 'recorded',
			trend: stats.durationTrend
		});

		// Tasks completed
		const tasksCompleted = stats.taskStats?.completed || 0;
		this.renderHighlightKPI(kpis, {
			value: String(tasksCompleted),
			label: 'tasks done',
			trend: null
		});

		// New locations (if any)
		this.renderHighlightKPI(kpis, {
			value: String(stats.uniqueLocations),
			label: 'places',
			trend: null
		});

		// Bullet highlights
		const bullets = tile.createDiv('omi-highlights-bullets');
		const bulletList = bullets.createEl('ul');

		// Generate dynamic highlights based on data
		const highlightItems = this.generateHighlightBullets(stats);
		for (const item of highlightItems) {
			bulletList.createEl('li', { text: item });
		}
	}

	private getHighlightsTitle(): string {
		switch (this.statsTimeRange) {
			case 'week':
				return "This Week's Highlights";
			case 'month':
				return "This Month's Highlights";
			case '30days':
				return "Last 30 Days Highlights";
			case 'all':
			default:
				return "This Week's Highlights";
		}
	}

	private renderHighlightKPI(container: HTMLElement, data: { value: string; label: string; trend: number | null }): void {
		const kpi = container.createDiv('omi-highlight-kpi');

		kpi.createEl('div', { text: data.value, cls: 'omi-highlight-kpi-value' });
		kpi.createEl('div', { text: data.label, cls: 'omi-highlight-kpi-label' });

		if (data.trend !== null && data.trend !== 0) {
			const trendEl = kpi.createDiv('omi-highlight-kpi-trend');
			const arrow = data.trend > 0 ? '↑' : '↓';
			const trendClass = data.trend > 0 ? 'positive' : 'negative';
			trendEl.addClass(trendClass);
			trendEl.setText(`${arrow}${Math.abs(Math.round(data.trend))}%`);
		}
	}

	private generateHighlightBullets(stats: StatsData): string[] {
		const highlights: string[] = [];

		// Most active day
		if (stats.peakDay) {
			highlights.push(`🌟 Most active day: ${stats.peakDay}`);
		}

		// Peak time
		if (stats.peakHour) {
			highlights.push(`⏰ Peak time: ${stats.peakHour}`);
		}

		// Streak status
		if (stats.streak > 0) {
			highlights.push(`🔥 Streak: ${stats.streak} days and counting!`);
		}

		// Top category
		if (stats.topCategory && stats.topCategory !== 'Unknown') {
			highlights.push(`🏷️ Top category: ${stats.topCategory}`);
		}

		// Memory count
		if (stats.memoryStats && stats.memoryStats.recentCount > 0) {
			highlights.push(`🧠 ${stats.memoryStats.recentCount} new memories this week`);
		}

		// Task completion
		if (stats.taskStats && stats.taskStats.completed > 0) {
			const rate = Math.round(stats.taskStats.completionRate * 100);
			highlights.push(`✅ Task completion rate: ${rate}%`);
		}

		// Limit to 4 highlights
		return highlights.slice(0, 4);
	}

	private renderSparkline(container: HTMLElement, data: number[], color: string): void {
		if (data.length < 2) return;

		const sparkline = container.createDiv('omi-stats-sparkline');

		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('viewBox', '0 0 100 30');
		svg.setAttribute('preserveAspectRatio', 'none');

		const max = Math.max(...data, 1);
		const min = Math.min(...data, 0);
		const range = max - min || 1;

		// Build path
		const points = data.map((val, i) => {
			const x = (i / (data.length - 1)) * 100;
			const y = 30 - ((val - min) / range) * 28 - 1;
			return `${x},${y}`;
		});

		const path = document.createElementNS(svgNS, 'path');
		path.setAttribute('d', `M ${points.join(' L ')}`);
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke', color);
		path.setAttribute('stroke-width', '2');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);

		// Area fill
		const area = document.createElementNS(svgNS, 'path');
		area.setAttribute('d', `M 0,30 L ${points.join(' L ')} L 100,30 Z`);
		area.setAttribute('fill', color);
		area.setAttribute('fill-opacity', '0.1');
		svg.appendChild(area);

		sparkline.appendChild(svg);
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

		// Calculate percentile-based thresholds for color levels
		// We need 3 thresholds to split days with conversations into 4 levels (1-4)
		// Level 0 is reserved for days with 0 conversations
		const counts = Array.from(dateCount.values()).filter(c => c > 0).sort((a, b) => a - b);
		let thresholds = [2, 4, 8]; // fallback for small datasets

		if (counts.length >= 3) {
			const p33 = counts[Math.floor(counts.length * 0.33)];
			const p66 = counts[Math.floor(counts.length * 0.66)];
			const p90 = counts[Math.floor(counts.length * 0.90)];

			// Use distinct thresholds, avoiding duplicates
			thresholds = [...new Set([p33, p66, p90])];

			// Ensure we have 3 distinct thresholds
			while (thresholds.length < 3) {
				thresholds.push(thresholds[thresholds.length - 1] + 1);
			}
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

				// Set intensity level (0-4) using percentile-based thresholds
				// Level 0 (gray) is ONLY for days with 0 conversations
				let level = 0;
				if (count === 0) level = 0;
				else if (count >= thresholds[2]) level = 4;
				else if (count >= thresholds[1]) level = 3;
				else if (count >= thresholds[0]) level = 2;
				else level = 1; // Any day with conversations gets at least level 1

				cell.addClass(`omi-heatmap-level-${level}`);
				cell.setAttribute('title', `${cellDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}\n${count} conversations\n${this.formatDuration(duration, true)}`);

				// Click to navigate to that day in conversations view
				if (count > 0) {
					cell.addClass('clickable');
					const clickDate = this.formatDateOnly(new Date(cellDate));
					cell.addEventListener('click', () => {
						this.activeTab = 'conversations';
						this.plugin.settings.activeHubTab = 'conversations';
						this.dailyViewSelectedDate = clickDate;
						this.plugin.saveSettings();
						this.render();
					});
				}

				cellDate.setDate(cellDate.getDate() + 7);
			}
		}

		// Legend with threshold tooltips
		const legend = heatmapContainer.createDiv('omi-heatmap-legend');
		legend.createEl('span', { text: 'Less' });
		for (let i = 0; i <= 4; i++) {
			const legendCell = legend.createDiv('omi-heatmap-cell omi-heatmap-legend-cell');
			legendCell.addClass(`omi-heatmap-level-${i}`);
			if (i === 0) {
				legendCell.setAttribute('title', '0 conversations');
			} else if (i === 1) {
				legendCell.setAttribute('title', `1-${thresholds[0] - 1} conversations`);
			} else {
				legendCell.setAttribute('title', `${thresholds[i - 2]}+ conversations`);
			}
		}
		legend.createEl('span', { text: 'More' });

		// Summary stats
		const summary = heatmapContainer.createDiv('omi-heatmap-summary');
		const totalConvs = conversationArray.length;
		const activeDays = dateCount.size;
		const avgPerDay = activeDays > 0 ? (totalConvs / activeDays).toFixed(1) : '0';

		const stat1 = summary.createEl('span');
		stat1.createEl('strong', { text: String(totalConvs) });
		stat1.appendText(` conversations in ${currentYear}`);
		const stat2 = summary.createEl('span');
		stat2.createEl('strong', { text: String(activeDays) });
		stat2.appendText(' active days');
		const stat3 = summary.createEl('span');
		stat3.createEl('strong', { text: String(avgPerDay) });
		stat3.appendText(' avg/day');
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

		// Map container element - uses flexbox to fill available space
		const mapEl = mapContainer.createDiv('omi-map-leaflet-container');
		mapEl.id = 'omi-leaflet-map-' + Date.now(); // Unique ID

		// Load Leaflet and initialize map
		this.loadLeaflet().then(() => {
			this.initializeMap(mapEl, conversationsWithGeo, uniqueLocations);

			// Add resize observer to handle window resizing
			const resizeObserver = new ResizeObserver(() => {
				if (this.mapInstance) {
					this.mapInstance.invalidateSize();
				}
			});
			resizeObserver.observe(mapEl);

			// Store observer for cleanup
			this.registerEvent(
				this.app.workspace.on('resize', () => {
					if (this.mapInstance) {
						this.mapInstance.invalidateSize();
					}
				})
			);
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
		} else if (context === 'all-done') {
			// Celebratory empty state when all tasks are completed
			empty.classList.add('celebratory');
			empty.createEl('div', { text: '🎊', cls: 'omi-empty-icon large' });
			empty.createEl('h3', { text: 'All caught up!' });
			empty.createEl('p', { text: 'You\'ve completed all your tasks. Take a moment to celebrate! 🥳' });

			// Show streak if active
			const { streak, isActive } = this.getStreakInfo();
			if (streak > 1 && isActive) {
				const streakNote = empty.createDiv('omi-empty-streak');
				streakNote.textContent = `🔥 ${streak} day streak - keep it going!`;
			}
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

	private renderProgressIndicator(toolbar: HTMLElement): void {
		// Calculate today's progress
		const today = new Date().toDateString();
		const todayTasks = this.tasks.filter(t => {
			if (!t.dueAt) return false;
			const dueDate = new Date(t.dueAt).toDateString();
			return dueDate === today;
		});

		// Also count overdue tasks as "due today" for progress tracking
		const overdueTasks = this.tasks.filter(t => {
			if (!t.dueAt || t.completed) return false;
			const dueDate = new Date(t.dueAt);
			return dueDate < new Date() && dueDate.toDateString() !== today;
		});

		const totalToday = todayTasks.length + overdueTasks.length;
		const completedToday = todayTasks.filter(t => t.completed).length;

		// Don't show if no tasks are due today
		if (totalToday === 0) return;

		const progressContainer = toolbar.createDiv('omi-progress-indicator');

		// Progress text
		const progressText = progressContainer.createEl('span', {
			cls: 'omi-progress-text'
		});

		if (completedToday === totalToday) {
			progressText.textContent = `✨ All ${totalToday} done!`;
			progressContainer.classList.add('complete');
		} else {
			progressText.textContent = `${completedToday} of ${totalToday} today`;
			if (overdueTasks.length > 0) {
				progressContainer.createEl('span', {
					text: ` (${overdueTasks.length} overdue)`,
					cls: 'omi-progress-overdue'
				});
			}
		}

		// Mini progress bar
		const progressBar = progressContainer.createDiv('omi-progress-bar');
		const progressFill = progressBar.createDiv('omi-progress-fill');
		const percentage = totalToday > 0 ? (completedToday / totalToday) * 100 : 0;
		progressFill.style.width = `${percentage}%`;

		// Add color class based on progress
		if (percentage === 100) {
			progressFill.classList.add('complete');
		} else if (percentage >= 50) {
			progressFill.classList.add('good');
		}
	}

	private renderBatchActionBar(container: HTMLElement): void {
		const bar = container.createDiv('omi-batch-action-bar');

		// Selection count
		const countSection = bar.createDiv('omi-batch-count');
		const count = this.selectedTaskIds.size;
		const pendingCount = this.tasks.filter(t => !t.completed).length;

		// Select all / Deselect all button
		const selectAllBtn = countSection.createEl('button', {
			text: count === pendingCount ? 'Deselect All' : 'Select All Pending',
			cls: 'omi-batch-select-all'
		});
		selectAllBtn.addEventListener('click', () => {
			if (count === pendingCount) {
				this.selectedTaskIds.clear();
			} else {
				// Select all pending tasks
				this.tasks.filter(t => !t.completed && t.id).forEach(t => {
					if (t.id) this.selectedTaskIds.add(t.id);
				});
			}
			this.render();
		});

		countSection.createEl('span', {
			text: `${count} selected`,
			cls: 'omi-batch-count-text'
		});

		// Action buttons (only show when items selected)
		if (count > 0) {
			const actions = bar.createDiv('omi-batch-actions');

			// Complete all selected
			const completeBtn = actions.createEl('button', {
				text: '✓ Complete',
				cls: 'omi-batch-btn omi-batch-complete'
			});
			completeBtn.addEventListener('click', () => this.batchComplete());

			// Reschedule dropdown
			const rescheduleBtn = actions.createEl('button', {
				text: '📅 Reschedule',
				cls: 'omi-batch-btn omi-batch-reschedule'
			});
			rescheduleBtn.addEventListener('click', (e) => this.showBatchRescheduleMenu(e.target as HTMLElement));

			// Delete all selected
			const deleteBtn = actions.createEl('button', {
				text: '🗑 Delete',
				cls: 'omi-batch-btn omi-batch-delete'
			});
			deleteBtn.addEventListener('click', () => this.batchDelete());
		}
	}

	private async batchComplete(): Promise<void> {
		const tasksToComplete = this.tasks.filter(t => t.id && this.selectedTaskIds.has(t.id) && !t.completed);

		if (tasksToComplete.length === 0) {
			new Notice('No pending tasks selected');
			return;
		}

		new Notice(`Completing ${tasksToComplete.length} tasks...`);

		let completed = 0;
		for (const task of tasksToComplete) {
			if (!task.id) continue;
			try {
				await this.plugin.api.updateActionItem(task.id, { completed: true });
				task.completed = true;
				completed++;
			} catch (err) {
				console.error('Failed to complete task:', task.id, err);
			}
		}

		// Clear selection and update streak
		this.selectedTaskIds.clear();
		this.isSelectMode = false;
		this.updateCompletionStreak();

		new Notice(`Completed ${completed} tasks!`);

		// Trigger celebration if all tasks done
		const pendingCount = this.tasks.filter(t => !t.completed).length;
		if (pendingCount === 0) {
			this.showConfetti();
		}

		this.render();
	}

	private showBatchRescheduleMenu(trigger: HTMLElement): void {
		// Remove any existing picker
		document.querySelectorAll('.omi-batch-reschedule-menu').forEach(el => el.remove());

		const menu = document.body.createDiv('omi-batch-reschedule-menu');

		// Position near the trigger
		const rect = trigger.getBoundingClientRect();
		menu.style.position = 'fixed';
		menu.style.top = `${rect.bottom + 4}px`;
		menu.style.left = `${rect.left}px`;
		menu.style.zIndex = '1000';

		// Quick options
		const options = [
			{ label: 'Today', days: 0 },
			{ label: 'Tomorrow', days: 1 },
			{ label: 'Next Week', days: 7 },
			{ label: 'No Deadline', days: -1 }
		];

		for (const opt of options) {
			const btn = menu.createEl('button', {
				text: opt.label,
				cls: 'omi-batch-menu-btn'
			});
			btn.addEventListener('click', async () => {
				menu.remove();
				await this.batchReschedule(opt.days);
			});
		}

		// Close on click outside
		const closeHandler = (e: MouseEvent) => {
			if (!menu.contains(e.target as Node)) {
				menu.remove();
				document.removeEventListener('click', closeHandler);
			}
		};
		setTimeout(() => document.addEventListener('click', closeHandler), 10);
	}

	private async batchReschedule(daysFromNow: number): Promise<void> {
		const tasksToReschedule = this.tasks.filter(t => t.id && this.selectedTaskIds.has(t.id));

		if (tasksToReschedule.length === 0) {
			new Notice('No tasks selected');
			return;
		}

		let newDueAt: string | null = null;
		if (daysFromNow >= 0) {
			const date = new Date();
			date.setDate(date.getDate() + daysFromNow);
			date.setHours(12, 0, 0, 0);
			newDueAt = date.toISOString();
		}

		new Notice(`Rescheduling ${tasksToReschedule.length} tasks...`);

		let updated = 0;
		for (const task of tasksToReschedule) {
			if (!task.id) continue;
			try {
				await this.plugin.api.updateActionItem(task.id, { due_at: newDueAt });
				task.dueAt = newDueAt;
				updated++;
			} catch (err) {
				console.error('Failed to reschedule task:', task.id, err);
			}
		}

		// Clear selection
		this.selectedTaskIds.clear();
		this.isSelectMode = false;

		new Notice(`Rescheduled ${updated} tasks`);
		this.render();
	}

	private async batchDelete(): Promise<void> {
		const tasksToDelete = this.tasks.filter(t => t.id && this.selectedTaskIds.has(t.id));

		if (tasksToDelete.length === 0) {
			new Notice('No tasks selected');
			return;
		}

		// Confirm deletion
		if (!confirm(`Delete ${tasksToDelete.length} tasks? This cannot be undone.`)) {
			return;
		}

		new Notice(`Deleting ${tasksToDelete.length} tasks...`);

		let deleted = 0;
		for (const task of tasksToDelete) {
			if (!task.id) continue;
			try {
				await this.plugin.api.deleteActionItem(task.id);
				deleted++;
			} catch (err) {
				console.error('Failed to delete task:', task.id, err);
			}
		}

		// Remove deleted tasks from local state
		this.tasks = this.tasks.filter(t => !t.id || !this.selectedTaskIds.has(t.id));

		// Clear selection
		this.selectedTaskIds.clear();
		this.isSelectMode = false;

		new Notice(`Deleted ${deleted} tasks`);
		this.render();
	}

	private renderViewModeTabs(container: HTMLElement): void {
		const tabs = container.createDiv('omi-tasks-view-tabs');
		tabs.setAttribute('role', 'tablist');
		tabs.setAttribute('aria-label', 'Task view modes');

		// Primary tabs (always visible)
		const primaryModes: Array<{ id: 'dashboard' | 'list'; label: string }> = [
			{ id: 'dashboard', label: '🎯 Today' },
			{ id: 'list', label: '☰ List' }
		];

		// Secondary views (in dropdown)
		const moreViews: Array<{ id: 'kanban' | 'calendar'; label: string }> = [
			{ id: 'kanban', label: '📌 Kanban' },
			{ id: 'calendar', label: '📅 Calendar' }
		];

		// Render primary tabs
		for (const mode of primaryModes) {
			const tab = tabs.createEl('button', {
				text: mode.label,
				cls: `omi-view-tab ${this.viewMode === mode.id ? 'active' : ''}`
			});
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', String(this.viewMode === mode.id));
			tab.setAttribute('aria-label', `${mode.label} view`);
			tab.addEventListener('click', async () => {
				this.viewMode = mode.id;
				this.plugin.settings.tasksViewMode = mode.id;
				await this.plugin.saveSettings();
				this.render();
			});
		}

		// "More" dropdown for secondary views
		const isMoreActive = moreViews.some(v => v.id === this.viewMode);
		const moreContainer = tabs.createDiv('omi-view-more-container');

		const moreBtn = moreContainer.createEl('button', {
			cls: `omi-view-tab omi-view-more-btn ${isMoreActive ? 'active' : ''}`
		});
		moreBtn.textContent = isMoreActive
			? `${moreViews.find(v => v.id === this.viewMode)?.label} ▾`
			: 'More ▾';
		moreBtn.setAttribute('aria-haspopup', 'true');
		moreBtn.setAttribute('aria-expanded', 'false');

		moreBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const existingDropdown = moreContainer.querySelector('.omi-view-more-dropdown');
			if (existingDropdown) {
				existingDropdown.remove();
				moreBtn.setAttribute('aria-expanded', 'false');
				return;
			}

			// Create dropdown
			const dropdown = moreContainer.createDiv('omi-view-more-dropdown');
			moreBtn.setAttribute('aria-expanded', 'true');

			for (const view of moreViews) {
				const item = dropdown.createEl('button', {
					text: view.label,
					cls: `omi-view-more-item ${this.viewMode === view.id ? 'active' : ''}`
				});
				item.addEventListener('click', async () => {
					this.viewMode = view.id;
					this.plugin.settings.tasksViewMode = view.id;
					await this.plugin.saveSettings();
					dropdown.remove();
					this.render();
				});
			}

			// Close on click outside
			const closeHandler = (evt: MouseEvent) => {
				if (!moreContainer.contains(evt.target as Node)) {
					dropdown.remove();
					moreBtn.setAttribute('aria-expanded', 'false');
					document.removeEventListener('click', closeHandler);
				}
			};
			setTimeout(() => document.addEventListener('click', closeHandler), 10);
		});
	}

	// ========================================
	// SMART DASHBOARD VIEW
	// Today-focused view with progress ring, priority tasks, and week calendar
	// ========================================
	private renderDashboardView(container: HTMLElement): void {
		const dashboard = container.createDiv('omi-dashboard');

		// Get today's data
		const today = new Date();
		const todayStr = today.toDateString();

		// Categorize tasks
		const overdueTasks = this.tasks.filter(t => {
			if (!t.dueAt || t.completed) return false;
			const dueDate = new Date(t.dueAt);
			return dueDate < today && dueDate.toDateString() !== todayStr;
		});

		const todayTasks = this.tasks.filter(t => {
			if (!t.dueAt) return false;
			return new Date(t.dueAt).toDateString() === todayStr;
		});

		const pendingToday = todayTasks.filter(t => !t.completed);
		const completedToday = todayTasks.filter(t => t.completed);
		const totalFocus = overdueTasks.length + todayTasks.length;
		const completedFocus = completedToday.length;

		// === HERO SECTION: Progress Ring + Encouragement ===
		const heroSection = dashboard.createDiv('omi-dashboard-hero');

		// Progress Ring (SVG)
		this.renderProgressRing(heroSection, completedFocus, totalFocus);

		// Encouragement message + streak
		const encouragement = heroSection.createDiv('omi-dashboard-encouragement');
		const { message, subtitle } = this.getEncouragementMessage(completedFocus, totalFocus, overdueTasks.length);
		encouragement.createEl('h2', { text: message, cls: 'omi-dashboard-message' });
		if (subtitle) {
			encouragement.createEl('p', { text: subtitle, cls: 'omi-dashboard-subtitle' });
		}

		// Streak indicator
		const { streak, isActive } = this.getStreakInfo();
		if (streak > 0 && isActive) {
			const streakBadge = encouragement.createDiv('omi-streak-badge');
			streakBadge.textContent = `🔥 ${streak} day streak`;
		}

		// === PRIORITY TASKS SECTION ===
		if (overdueTasks.length > 0 || pendingToday.length > 0) {
			const prioritySection = dashboard.createDiv('omi-dashboard-section');
			prioritySection.createEl('h3', { text: '🔥 Priority Tasks', cls: 'omi-dashboard-section-title' });

			const tasksList = prioritySection.createDiv('omi-dashboard-tasks');

			// Overdue tasks first (sorted by how overdue)
			const sortedOverdue = [...overdueTasks].sort((a, b) => {
				return new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime();
			});

			for (const task of sortedOverdue) {
				this.renderDashboardTask(tasksList, task, 'overdue');
			}

			// Today's pending tasks (sorted by time if available)
			const sortedToday = [...pendingToday].sort((a, b) => {
				const aHasTime = a.dueAt?.includes('T') && !a.dueAt.endsWith('T00:00:00');
				const bHasTime = b.dueAt?.includes('T') && !b.dueAt.endsWith('T00:00:00');
				if (aHasTime && bHasTime) {
					return new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime();
				}
				if (aHasTime) return -1;
				if (bHasTime) return 1;
				return 0;
			});

			for (const task of sortedToday) {
				this.renderDashboardTask(tasksList, task, 'today');
			}
		}

		// === COMPLETED TODAY SECTION (collapsible) ===
		if (completedToday.length > 0) {
			const completedSection = dashboard.createDiv('omi-dashboard-section omi-dashboard-completed');
			const header = completedSection.createDiv('omi-dashboard-section-header');
			header.createEl('h3', { text: `✅ Completed Today (${completedToday.length})`, cls: 'omi-dashboard-section-title' });

			const tasksList = completedSection.createDiv('omi-dashboard-tasks');
			for (const task of completedToday) {
				this.renderDashboardTask(tasksList, task, 'completed');
			}
		}

		// === WEEK AT A GLANCE ===
		this.renderWeekAtAGlance(dashboard);
	}

	private renderProgressRing(container: HTMLElement, completed: number, total: number): void {
		const ringContainer = container.createDiv('omi-progress-ring-container');

		const size = 120;
		const strokeWidth = 10;
		const radius = (size - strokeWidth) / 2;
		const circumference = radius * 2 * Math.PI;
		const percentage = total > 0 ? (completed / total) * 100 : 0;
		const offset = circumference - (percentage / 100) * circumference;

		// Create SVG
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', String(size));
		svg.setAttribute('height', String(size));
		svg.classList.add('omi-progress-ring');

		// Background circle
		const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		bgCircle.setAttribute('cx', String(size / 2));
		bgCircle.setAttribute('cy', String(size / 2));
		bgCircle.setAttribute('r', String(radius));
		bgCircle.setAttribute('fill', 'none');
		bgCircle.setAttribute('stroke', 'var(--background-modifier-border)');
		bgCircle.setAttribute('stroke-width', String(strokeWidth));
		svg.appendChild(bgCircle);

		// Progress circle
		const progressCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		progressCircle.setAttribute('cx', String(size / 2));
		progressCircle.setAttribute('cy', String(size / 2));
		progressCircle.setAttribute('r', String(radius));
		progressCircle.setAttribute('fill', 'none');
		progressCircle.setAttribute('stroke', percentage === 100 ? 'var(--omi-color-success)' : 'var(--omi-purple-primary)');
		progressCircle.setAttribute('stroke-width', String(strokeWidth));
		progressCircle.setAttribute('stroke-linecap', 'round');
		progressCircle.setAttribute('stroke-dasharray', String(circumference));
		progressCircle.setAttribute('stroke-dashoffset', String(circumference)); // Start at 0
		progressCircle.classList.add('omi-progress-ring-circle');
		progressCircle.style.setProperty('--target-offset', String(offset));
		svg.appendChild(progressCircle);

		ringContainer.appendChild(svg);

		// Center text
		const centerText = ringContainer.createDiv('omi-progress-ring-text');
		if (total === 0) {
			centerText.textContent = '—';
		} else if (percentage === 100) {
			centerText.textContent = '🎉';
			centerText.classList.add('celebration');
		} else {
			centerText.textContent = `${Math.round(percentage)}%`;
		}
	}

	private getEncouragementMessage(completed: number, total: number, overdue: number): { message: string; subtitle: string | null } {
		if (total === 0) {
			return { message: 'No tasks for today', subtitle: 'Enjoy your free time! ✨' };
		}

		const percentage = (completed / total) * 100;

		if (percentage === 100) {
			return { message: 'All done!', subtitle: 'You crushed it today! 🎉' };
		}

		if (overdue > 0 && completed === 0) {
			return {
				message: `${overdue} overdue task${overdue > 1 ? 's' : ''}`,
				subtitle: 'Let\'s tackle these first'
			};
		}

		if (percentage === 0) {
			return { message: 'Ready to start?', subtitle: `${total} task${total > 1 ? 's' : ''} waiting for you` };
		}

		if (percentage < 25) {
			return { message: 'Good start!', subtitle: `${total - completed} more to go` };
		}

		if (percentage < 50) {
			return { message: 'Making progress!', subtitle: `${total - completed} tasks remaining` };
		}

		if (percentage < 75) {
			return { message: 'More than halfway!', subtitle: `Just ${total - completed} left` };
		}

		return { message: 'Almost there!', subtitle: `Only ${total - completed} to go` };
	}

	private renderDashboardTask(container: HTMLElement, task: TaskWithUI, type: 'overdue' | 'today' | 'completed'): void {
		const row = container.createDiv(`omi-dashboard-task omi-dashboard-task--${type}`);
		if (task.completed) {
			row.classList.add('completed');
		}

		// Checkbox with particles
		const checkboxWrapper = row.createDiv('omi-task-checkbox-wrapper');
		const checkbox = checkboxWrapper.createEl('input', { type: 'checkbox' });
		checkbox.checked = task.completed;

		const particles = checkboxWrapper.createDiv('omi-checkbox-particles');
		for (let i = 0; i < 8; i++) {
			particles.createDiv('omi-checkbox-particle');
		}

		checkbox.addEventListener('change', async () => {
			row.classList.add('completing');
			if (!task.completed) {
				particles.classList.add('burst');
				this.showTaskCelebration(row, task);
			}
			await this.toggleTaskCompletion(task);
		});

		// Task content
		const content = row.createDiv('omi-dashboard-task-content');
		content.createEl('span', { text: task.description, cls: 'omi-dashboard-task-desc' });

		// Time/date indicator and snooze actions
		const actionsContainer = row.createDiv('omi-dashboard-task-actions');

		if (type === 'overdue') {
			const daysOverdue = Math.floor((Date.now() - new Date(task.dueAt!).getTime()) / (1000 * 60 * 60 * 24));
			const timeLabel = actionsContainer.createDiv('omi-dashboard-task-time overdue');
			timeLabel.textContent = daysOverdue === 1 ? '1 day late' : `${daysOverdue} days late`;

			// Snooze buttons for overdue tasks
			const snoozeContainer = actionsContainer.createDiv('omi-snooze-buttons');

			const snoozeToday = snoozeContainer.createEl('button', {
				text: 'Today',
				cls: 'omi-snooze-btn'
			});
			snoozeToday.addEventListener('click', async (e) => {
				e.stopPropagation();
				await this.snoozeTask(task, 0);
			});

			const snoozeTomorrow = snoozeContainer.createEl('button', {
				text: '+1 day',
				cls: 'omi-snooze-btn'
			});
			snoozeTomorrow.addEventListener('click', async (e) => {
				e.stopPropagation();
				await this.snoozeTask(task, 1);
			});

			const snoozeWeek = snoozeContainer.createEl('button', {
				text: '+7 days',
				cls: 'omi-snooze-btn'
			});
			snoozeWeek.addEventListener('click', async (e) => {
				e.stopPropagation();
				await this.snoozeTask(task, 7);
			});
		} else if (task.dueAt) {
			const timeLabel = actionsContainer.createDiv('omi-dashboard-task-time');
			const hasTime = task.dueAt.includes('T') && !task.dueAt.endsWith('T00:00:00');
			if (hasTime) {
				timeLabel.textContent = this.formatTimeOnly(task.dueAt);
			} else {
				timeLabel.textContent = type === 'completed' ? 'Done' : 'Today';
			}
		}

		// Click to edit
		content.addEventListener('click', () => this.showEditTaskModal(task));
	}

	private async snoozeTask(task: TaskWithUI, daysFromNow: number): Promise<void> {
		if (!task.id) return;

		const newDate = new Date();
		newDate.setDate(newDate.getDate() + daysFromNow);
		newDate.setHours(9, 0, 0, 0); // Set to 9 AM

		const utcDate = newDate.toISOString();

		try {
			await this.plugin.api.updateActionItem(task.id, { due_at: utcDate });
			task.dueAt = newDate.toISOString().split('T')[0] + 'T09:00';
			new Notice(`Task snoozed to ${daysFromNow === 0 ? 'today' : daysFromNow === 1 ? 'tomorrow' : newDate.toLocaleDateString()}`);
			this.render();
			this.requestBackupSync();
		} catch (error) {
			console.error('Error snoozing task:', error);
			new Notice('Failed to snooze task');
		}
	}

	private renderWeekAtAGlance(container: HTMLElement): void {
		const section = container.createDiv('omi-dashboard-section');
		section.createEl('h3', { text: '📅 This Week', cls: 'omi-dashboard-section-title' });

		const weekStrip = section.createDiv('omi-week-strip');

		const today = new Date();
		const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

		// Show 7 days starting from today
		for (let i = 0; i < 7; i++) {
			const date = new Date(today);
			date.setDate(today.getDate() + i);
			const dateStr = date.toDateString();

			// Count tasks for this day
			const dayTasks = this.tasks.filter(t => {
				if (!t.dueAt) return false;
				return new Date(t.dueAt).toDateString() === dateStr;
			});
			const pendingCount = dayTasks.filter(t => !t.completed).length;
			const completedCount = dayTasks.filter(t => t.completed).length;

			const dayCell = weekStrip.createDiv('omi-week-day');
			if (i === 0) dayCell.classList.add('today');

			// Day name
			dayCell.createEl('span', {
				text: i === 0 ? 'Today' : dayNames[date.getDay()],
				cls: 'omi-week-day-name'
			});

			// Day number
			dayCell.createEl('span', {
				text: String(date.getDate()),
				cls: 'omi-week-day-number'
			});

			// Task count indicator
			if (pendingCount > 0 || completedCount > 0) {
				const indicator = dayCell.createDiv('omi-week-day-indicator');
				if (pendingCount === 0 && completedCount > 0) {
					indicator.classList.add('all-done');
					indicator.textContent = '✓';
				} else {
					indicator.textContent = String(pendingCount);
					if (pendingCount > 3) indicator.classList.add('busy');
				}
			}

			// Click to jump to that day in calendar
			dayCell.addEventListener('click', async () => {
				this.calendarCurrentDate = date;
				this.viewMode = 'calendar';
				this.calendarViewType = 'weekly';
				this.plugin.settings.tasksViewMode = 'calendar';
				this.plugin.settings.tasksCalendarType = 'weekly';
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
		const board = container.createDiv('omi-kanban-board');
		const filtered = this.getFilteredTasks();

		// Only show pending tasks in Kanban
		const pendingTasks = filtered.filter(t => !t.completed);

		// Date-based layout: Today, Tomorrow, No Deadline, Later
		const grouped = this.groupTasksByDateColumn(pendingTasks);
		this.renderKanbanColumn(board, '🌅 Today', grouped.today, 'today');
		this.renderKanbanColumn(board, '📆 Tomorrow', grouped.tomorrow, 'tomorrow');
		this.renderKanbanColumn(board, '📋 No Deadline', grouped.noDeadline, 'noDeadline');
		this.renderKanbanColumn(board, '🗓️ Later', grouped.later, 'later');
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
			// Date-based: update due date
			const newDueAt = this.getDateForColumn(columnId);
			const utcDate = this.localToUTC(newDueAt);
			await this.plugin.api.updateActionItem(task.id, { due_at: utcDate });
			task.dueAt = newDueAt;
			this.render();
			this.requestBackupSync();
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
		if (task.id && this.selectedTaskIds.has(task.id)) rowClasses.push('selected');
		const row = container.createDiv(rowClasses.join(' '));
		row.setAttribute('role', 'listitem');
		row.setAttribute('tabindex', '0');

		// Check if task is overdue (for date display)
		const isOverdueTask = task.dueAt && this.isOverdue(task.dueAt) && !task.completed;

		// Selection checkbox (in select mode)
		if (this.isSelectMode && task.id) {
			const selectCheckbox = row.createEl('input', {
				type: 'checkbox',
				cls: 'omi-task-select-checkbox'
			});
			selectCheckbox.checked = this.selectedTaskIds.has(task.id);
			selectCheckbox.setAttribute('aria-label', `Select "${task.description}"`);
			selectCheckbox.addEventListener('click', (e) => e.stopPropagation());
			selectCheckbox.addEventListener('change', () => {
				if (task.id) {
					if (selectCheckbox.checked) {
						this.selectedTaskIds.add(task.id);
					} else {
						this.selectedTaskIds.delete(task.id);
					}
					this.render();
				}
			});
		}

		// Checkbox with particle burst wrapper
		const checkboxWrapper = row.createDiv('omi-task-checkbox-wrapper');
		const checkbox = checkboxWrapper.createEl('input', { type: 'checkbox' });
		checkbox.checked = task.completed;
		checkbox.setAttribute('aria-label', `Mark "${task.description}" as ${task.completed ? 'pending' : 'completed'}`);

		// Create particle burst container (8 particles in a circle)
		const particles = checkboxWrapper.createDiv('omi-checkbox-particles');
		for (let i = 0; i < 8; i++) {
			particles.createDiv('omi-checkbox-particle');
		}

		checkbox.addEventListener('change', async () => {
			// Add completing animation
			row.classList.add('completing');

			// Trigger particle burst on completion (not on unchecking)
			if (!task.completed) {
				particles.classList.add('burst');
				// Show celebration message for completing
				this.showTaskCelebration(row, task);
			}

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

		// Date subtitle (contextual based on section) - click for inline date picker
		const dateSubtitle = contentWrapper.createEl('span', { cls: 'omi-task-date-subtitle' });
		dateSubtitle.addEventListener('click', (e) => {
			e.stopPropagation();
			this.showDatePicker(task, dateSubtitle);
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

			// Update streak if completing a task
			if (newCompleted) {
				await this.updateCompletionStreak();
			}

			this.render();  // Just re-render, no file operations
			this.requestBackupSync();
		} catch (error) {
			console.error('Error updating task:', error);
			new Notice('Failed to update task');
		}
	}

	private async updateCompletionStreak(): Promise<void> {
		const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
		const lastCompletion = this.plugin.settings.lastTaskCompletionDate;

		if (lastCompletion === today) {
			// Already completed something today, streak unchanged
			return;
		}

		// Check if last completion was yesterday
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const yesterdayStr = yesterday.toISOString().split('T')[0];

		if (lastCompletion === yesterdayStr) {
			// Continue streak
			this.plugin.settings.taskCompletionStreak += 1;
		} else if (!lastCompletion) {
			// First ever completion
			this.plugin.settings.taskCompletionStreak = 1;
		} else {
			// Streak broken, start new one
			this.plugin.settings.taskCompletionStreak = 1;
		}

		this.plugin.settings.lastTaskCompletionDate = today;
		await this.plugin.saveSettings();
	}

	private getStreakInfo(): { streak: number; isActive: boolean } {
		const streak = this.plugin.settings.taskCompletionStreak;
		const lastCompletion = this.plugin.settings.lastTaskCompletionDate;
		const today = new Date().toISOString().split('T')[0];
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const yesterdayStr = yesterday.toISOString().split('T')[0];

		// Streak is active if last completion was today or yesterday
		const isActive = lastCompletion === today || lastCompletion === yesterdayStr;

		return { streak: isActive ? streak : 0, isActive };
	}

	// Celebration messages for task completion
	private readonly celebrationMessages = [
		'Nice!', 'Done!', 'Got it!', 'Crushed it!', 'Boom!',
		'Yes!', 'Nailed it!', 'Sweet!', 'Awesome!', 'Great!'
	];

	private showTaskCelebration(row: HTMLElement, task: TaskWithUI): void {
		// Play completion sound (if enabled)
		this.playCompletionSound();

		// Count how many tasks are completed today to pick appropriate message
		const todayTasks = this.tasks.filter(t => {
			if (!t.dueAt) return false;
			const dueDate = new Date(t.dueAt).toDateString();
			return dueDate === new Date().toDateString();
		});
		const completedToday = todayTasks.filter(t => t.completed).length + 1; // +1 for current
		const isAllDone = completedToday === todayTasks.length && todayTasks.length > 0;

		// Pick message based on progress
		let message: string;
		if (isAllDone) {
			message = 'All done! 🎉';
			// Trigger confetti for completing all tasks!
			this.showConfetti();
		} else if (completedToday >= 5) {
			message = 'On fire! 🔥';
		} else if (completedToday >= 3) {
			message = 'Rolling! ⚡';
		} else {
			// Random encouraging message
			message = this.celebrationMessages[Math.floor(Math.random() * this.celebrationMessages.length)];
		}

		// Create and show celebration popup
		const celebration = row.createEl('span', {
			text: message,
			cls: 'omi-task-celebration'
		});

		// Auto-remove after animation completes
		setTimeout(() => {
			celebration.remove();
		}, 1100);
	}

	private playCompletionSound(): void {
		if (!this.plugin.settings.enableTaskSounds) return;

		try {
			// Create audio context and play a pleasant "ding" sound
			const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();

			// Create oscillator for the main tone
			const oscillator = audioContext.createOscillator();
			const gainNode = audioContext.createGain();

			oscillator.connect(gainNode);
			gainNode.connect(audioContext.destination);

			// Pleasant bell-like sound
			oscillator.type = 'sine';
			oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // A5
			oscillator.frequency.exponentialRampToValueAtTime(1320, audioContext.currentTime + 0.1); // E6

			// Quick fade in and out
			gainNode.gain.setValueAtTime(0, audioContext.currentTime);
			gainNode.gain.linearRampToValueAtTime(0.15, audioContext.currentTime + 0.02);
			gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

			oscillator.start(audioContext.currentTime);
			oscillator.stop(audioContext.currentTime + 0.3);

			// Cleanup
			setTimeout(() => {
				audioContext.close();
			}, 500);
		} catch {
			// Audio not supported or blocked, fail silently
		}
	}

	private showConfetti(): void {
		// Create canvas overlay for confetti
		const canvas = document.createElement('canvas');
		canvas.classList.add('omi-confetti-canvas');
		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;
		document.body.appendChild(canvas);

		const ctx = canvas.getContext('2d');
		if (!ctx) {
			canvas.remove();
			return;
		}

		// Confetti particle system
		const colors = ['#8B5CF6', '#A855F7', '#10B981', '#F59E0B', '#EF4444', '#3B82F6', '#EC4899'];
		const particles: Array<{
			x: number;
			y: number;
			vx: number;
			vy: number;
			color: string;
			size: number;
			rotation: number;
			rotationSpeed: number;
			shape: 'square' | 'circle';
		}> = [];

		// Create particles
		for (let i = 0; i < 150; i++) {
			particles.push({
				x: canvas.width / 2 + (Math.random() - 0.5) * 200,
				y: canvas.height / 2,
				vx: (Math.random() - 0.5) * 15,
				vy: Math.random() * -15 - 5,
				color: colors[Math.floor(Math.random() * colors.length)],
				size: Math.random() * 8 + 4,
				rotation: Math.random() * Math.PI * 2,
				rotationSpeed: (Math.random() - 0.5) * 0.2,
				shape: Math.random() > 0.5 ? 'square' : 'circle'
			});
		}

		const gravity = 0.3;
		const friction = 0.99;
		let frame = 0;
		const maxFrames = 180; // 3 seconds at 60fps

		const animate = () => {
			ctx.clearRect(0, 0, canvas.width, canvas.height);

			for (const p of particles) {
				p.vy += gravity;
				p.vx *= friction;
				p.x += p.vx;
				p.y += p.vy;
				p.rotation += p.rotationSpeed;

				ctx.save();
				ctx.translate(p.x, p.y);
				ctx.rotate(p.rotation);
				ctx.fillStyle = p.color;

				if (p.shape === 'square') {
					ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
				} else {
					ctx.beginPath();
					ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
					ctx.fill();
				}

				ctx.restore();
			}

			frame++;
			if (frame < maxFrames) {
				requestAnimationFrame(animate);
			} else {
				canvas.remove();
			}
		};

		animate();
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

	private showDatePicker(task: TaskWithUI, anchorEl?: HTMLElement): void {
		// If anchor element provided, show inline picker; otherwise fall back to modal
		if (anchorEl) {
			this.showInlineDatePicker(task, anchorEl);
		} else {
			const modal = new DatePickerModal(this.app, task.dueAt, async (newDate: string | null) => {
				if (!task.id) return;
				try {
					const utcDate = this.localToUTC(newDate);
					await this.plugin.api.updateActionItem(task.id, { due_at: utcDate });
					task.dueAt = newDate;
					this.render();
					this.requestBackupSync();
				} catch (error) {
					console.error('Error updating due date:', error);
					new Notice('Failed to update due date');
				}
			});
			modal.open();
		}
	}

	private showInlineDatePicker(task: TaskWithUI, anchorEl: HTMLElement): void {
		// Remove any existing inline picker
		const existingPicker = document.querySelector('.omi-inline-date-picker');
		if (existingPicker) existingPicker.remove();

		// Create picker dropdown
		const picker = document.createElement('div');
		picker.classList.add('omi-inline-date-picker');

		// Position relative to anchor
		const rect = anchorEl.getBoundingClientRect();
		picker.style.top = `${rect.bottom + 4}px`;
		picker.style.left = `${rect.left}px`;

		// Quick shortcuts section
		const shortcuts = picker.createDiv('omi-date-shortcuts');
		shortcuts.createEl('div', { text: 'Quick Set', cls: 'omi-date-shortcuts-title' });

		const shortcutButtons = [
			{ label: 'Today', days: 0 },
			{ label: 'Tomorrow', days: 1 },
			{ label: 'Next Week', days: 7 },
			{ label: 'No Date', days: null }
		];

		for (const shortcut of shortcutButtons) {
			const btn = shortcuts.createEl('button', {
				text: shortcut.label,
				cls: 'omi-date-shortcut-btn'
			});

			if (shortcut.days === null) {
				btn.classList.add('clear');
			}

			btn.addEventListener('click', async () => {
				let newDate: string | null = null;

				if (shortcut.days !== null) {
					const date = new Date();
					date.setDate(date.getDate() + shortcut.days);
					date.setHours(9, 0, 0, 0);
					newDate = date.toISOString().split('T')[0] + 'T09:00';
				}

				await this.updateTaskDate(task, newDate);
				picker.remove();
			});
		}

		// Divider
		picker.createDiv('omi-date-picker-divider');

		// Custom date/time inputs
		const customSection = picker.createDiv('omi-date-custom');

		const dateInput = customSection.createEl('input', {
			type: 'date',
			cls: 'omi-date-input'
		});
		if (task.dueAt) {
			dateInput.value = task.dueAt.split('T')[0];
		}

		const timeInput = customSection.createEl('input', {
			type: 'time',
			cls: 'omi-time-input'
		});
		if (task.dueAt && task.dueAt.includes('T')) {
			const timePart = task.dueAt.split('T')[1];
			if (timePart && timePart !== '00:00:00' && timePart !== '00:00') {
				timeInput.value = timePart.substring(0, 5);
			}
		}

		// Apply button
		const applyBtn = customSection.createEl('button', {
			text: 'Apply',
			cls: 'omi-date-apply-btn'
		});
		applyBtn.addEventListener('click', async () => {
			if (!dateInput.value) {
				await this.updateTaskDate(task, null);
			} else {
				const newDate = timeInput.value
					? `${dateInput.value}T${timeInput.value}`
					: `${dateInput.value}T00:00`;
				await this.updateTaskDate(task, newDate);
			}
			picker.remove();
		});

		// Add to DOM
		document.body.appendChild(picker);

		// Click outside to close
		const closeHandler = (e: MouseEvent) => {
			if (!picker.contains(e.target as Node) && e.target !== anchorEl) {
				picker.remove();
				document.removeEventListener('click', closeHandler);
			}
		};
		// Delay adding listener to avoid immediate close
		setTimeout(() => document.addEventListener('click', closeHandler), 10);

		// ESC to close
		const escHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				picker.remove();
				document.removeEventListener('keydown', escHandler);
			}
		};
		document.addEventListener('keydown', escHandler);
	}

	private async updateTaskDate(task: TaskWithUI, newDate: string | null): Promise<void> {
		if (!task.id) return;
		try {
			const utcDate = this.localToUTC(newDate);
			await this.plugin.api.updateActionItem(task.id, { due_at: utcDate });
			task.dueAt = newDate;
			this.render();
			this.requestBackupSync();
		} catch (error) {
			console.error('Error updating due date:', error);
			new Notice('Failed to update due date');
		}
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