import { ItemView, WorkspaceLeaf, Notice, debounce } from 'obsidian';
import { VIEW_TYPE_OMI_HUB } from './constants';
import { TaskWithUI, SyncedConversationMeta, ConversationDetailData, ActionItem, CalendarEvent, TranscriptSegment } from './types';
import { AddTaskModal, DatePickerModal, EditTaskModal } from './modals';
import type OmiConversationsPlugin from './main';

export class OmiHubView extends ItemView {
	plugin: OmiConversationsPlugin;

	// Hub state
	activeTab: 'tasks' | 'conversations' = 'tasks';

	// Tasks state
	tasks: TaskWithUI[] = [];
	searchQuery = '';
	pendingCollapsed = false;
	completedCollapsed = false;
	private autoRefreshInterval: number | null = null;
	isLoading = false;

	// View mode state
	viewMode: 'list' | 'kanban' | 'calendar' = 'list';
	kanbanLayout: 'status' | 'date' = 'status';
	calendarViewType: 'monthly' | 'weekly' = 'monthly';
	calendarCurrentDate: Date = new Date();
	private draggedTask: TaskWithUI | null = null;

	// Conversations state
	isSyncingConversations = false;
	selectedConversationId: string | null = null;
	detailTab: 'summary' | 'transcript' = 'summary';
	selectedConversationData: ConversationDetailData | null = null;
	isLoadingDetail = false;

	// Debounced backup sync
	private requestBackupSync: () => void;

	constructor(leaf: WorkspaceLeaf, plugin: OmiConversationsPlugin) {
		super(leaf);
		this.plugin = plugin;
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

		// Load tasks if on tasks tab
		if (this.activeTab === 'tasks') {
			await this.loadTasks();
		}
		this.render();
		this.startAutoRefresh();

		// Register keyboard shortcuts
		this.containerEl.addEventListener('keydown', this.handleKeyDown.bind(this));
	}

	async onClose(): Promise<void> {
		this.stopAutoRefresh();
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
		} else {
			this.renderConversationsTab(container);
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
	}

	private renderTasksTab(container: HTMLElement): void {
		const tabContent = container.createDiv('omi-tasks-container');

		// View Mode Tabs
		this.renderViewModeTabs(tabContent);

		// Toolbar: Search + Sync button
		const toolbar = tabContent.createDiv('omi-tasks-toolbar');
		toolbar.setAttribute('role', 'toolbar');

		const searchInput = toolbar.createEl('input', {
			type: 'text',
			placeholder: 'Search tasks...',
			cls: 'omi-tasks-search'
		});
		searchInput.value = this.searchQuery;
		searchInput.setAttribute('aria-label', 'Search tasks');
		searchInput.addEventListener('input', (e) => {
			this.searchQuery = (e.target as HTMLInputElement).value;
			this.render();
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
			// Still show add button
			const addBtn = tabContent.createEl('button', { text: '+ Add Task', cls: 'omi-tasks-add-btn' });
			addBtn.setAttribute('aria-label', 'Add new task');
			addBtn.addEventListener('click', () => this.showAddTaskDialog());
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

		// Add new task button
		const addBtn = tabContent.createEl('button', { text: '+ Add Task', cls: 'omi-tasks-add-btn' });
		addBtn.setAttribute('aria-label', 'Add new task');
		addBtn.addEventListener('click', () => this.showAddTaskDialog());
	}

	private renderConversationsTab(container: HTMLElement): void {
		const tabContent = container.createDiv('omi-conversations-container');

		// View Mode Tabs (List, Timeline, Stats, Heatmap)
		this.renderConversationsViewModeTabs(tabContent);

		// Time Range Toggle (for applicable views)
		const currentViewMode = this.plugin.settings.conversationsViewMode || 'list';
		if (currentViewMode === 'list' || currentViewMode === 'timeline') {
			this.renderConversationsTimeRangeToggle(tabContent);
		}

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
				this.renderConversationsList(tabContent);
				break;
			case 'timeline':
				this.renderConversationsTimeline(tabContent);
				break;
			case 'stats':
				this.renderConversationsStats(tabContent);
				break;
			case 'heatmap':
				this.renderConversationsHeatmap(tabContent);
				break;
			default:
				this.renderConversationsList(tabContent);
		}
	}

	private renderConversationsViewModeTabs(container: HTMLElement): void {
		const tabs = container.createDiv('omi-conversations-view-tabs');
		tabs.setAttribute('role', 'tablist');
		tabs.setAttribute('aria-label', 'Conversation view modes');

		const currentMode = this.plugin.settings.conversationsViewMode || 'list';
		const modes: Array<{ id: 'list' | 'timeline' | 'stats' | 'heatmap'; label: string; icon: string }> = [
			{ id: 'list', label: 'Cards', icon: '📋' },
			{ id: 'timeline', label: 'Timeline', icon: '⏱️' },
			{ id: 'stats', label: 'Stats', icon: '📊' },
			{ id: 'heatmap', label: 'Heatmap', icon: '🔥' }
		];

		for (const mode of modes) {
			const tab = tabs.createEl('button', {
				text: `${mode.icon} ${mode.label}`,
				cls: `omi-conv-view-tab ${currentMode === mode.id ? 'active' : ''}`
			});
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', String(currentMode === mode.id));
			tab.setAttribute('aria-label', `${mode.label} view`);
			tab.addEventListener('click', async () => {
				this.plugin.settings.conversationsViewMode = mode.id;
				await this.plugin.saveSettings();
				this.render();
			});
		}
	}

	private renderConversationsTimeRangeToggle(container: HTMLElement): void {
		const toggle = container.createDiv('omi-conversations-time-toggle');
		const currentRange = this.plugin.settings.conversationsTimeRange || 'daily';

		const dailyBtn = toggle.createEl('button', {
			text: 'Daily',
			cls: `omi-time-toggle-btn ${currentRange === 'daily' ? 'active' : ''}`
		});
		const weeklyBtn = toggle.createEl('button', {
			text: 'Weekly',
			cls: `omi-time-toggle-btn ${currentRange === 'weekly' ? 'active' : ''}`
		});

		dailyBtn.addEventListener('click', async () => {
			this.plugin.settings.conversationsTimeRange = 'daily';
			await this.plugin.saveSettings();
			this.render();
		});
		weeklyBtn.addEventListener('click', async () => {
			this.plugin.settings.conversationsTimeRange = 'weekly';
			await this.plugin.saveSettings();
			this.render();
		});
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

	private renderConversationsList(container: HTMLElement): void {
		const conversations = this.plugin.settings.syncedConversations || {};
		const conversationArray = Object.values(conversations) as SyncedConversationMeta[];

		if (conversationArray.length === 0) {
			const empty = container.createDiv('omi-conversations-empty');
			empty.createEl('div', { text: '💬', cls: 'omi-empty-icon' });
			empty.createEl('h3', { text: 'No conversations synced' });
			empty.createEl('p', { text: 'Click "Sync New" to fetch your Omi conversations' });
			return;
		}

		// Split layout container
		const splitContainer = container.createDiv('omi-conversations-split');

		// Left pane: scrollable list
		const listPane = splitContainer.createDiv('omi-conversations-list-pane');
		this.renderConversationsListContent(listPane, conversationArray);

		// Right pane: detail panel (if conversation selected)
		if (this.selectedConversationId) {
			const detailPane = splitContainer.createDiv('omi-conversations-detail-pane');
			this.renderConversationDetailPanel(detailPane);
		}
	}

	private renderConversationsListContent(listPane: HTMLElement, conversationArray: SyncedConversationMeta[]): void {
		// Group by date
		const groupedByDate = new Map<string, SyncedConversationMeta[]>();
		for (const conv of conversationArray) {
			const dateKey = conv.date;
			if (!groupedByDate.has(dateKey)) {
				groupedByDate.set(dateKey, []);
			}
			groupedByDate.get(dateKey)!.push(conv);
		}

		// Sort dates descending (newest first)
		const sortedDates = Array.from(groupedByDate.keys()).sort((a, b) => b.localeCompare(a));

		// For weekly view, group by week
		const timeRange = this.plugin.settings.conversationsTimeRange || 'daily';
		if (timeRange === 'weekly') {
			this.renderConversationsWeeklyList(listPane, groupedByDate, sortedDates);
			return;
		}

		// Daily view (original behavior with enhanced cards)
		for (const dateStr of sortedDates) {
			const dateGroup = listPane.createDiv('omi-conversation-date-group');

			// Format date nicely
			const dateObj = new Date(dateStr + 'T00:00:00');
			const formattedDate = dateObj.toLocaleDateString('en-US', {
				weekday: 'long',
				month: 'long',
				day: 'numeric',
				year: 'numeric'
			});
			dateGroup.createEl('div', { text: formattedDate, cls: 'omi-conversation-date-header' });

			const convs = groupedByDate.get(dateStr)!;
			// Sort by time descending within each day (latest first)
			convs.sort((a, b) => {
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
				return parseTime(b.time) - parseTime(a.time);
			});

			for (const conv of convs) {
				this.renderConversationCard(dateGroup, conv);
			}
		}
	}

	private renderConversationsWeeklyList(
		container: HTMLElement,
		groupedByDate: Map<string, SyncedConversationMeta[]>,
		sortedDates: string[]
	): void {
		// Group dates by week
		const weekGroups = new Map<string, string[]>();
		for (const dateStr of sortedDates) {
			const date = new Date(dateStr + 'T00:00:00');
			const weekStart = this.getWeekStartDate(date);
			const weekKey = this.formatDateOnly(weekStart);
			if (!weekGroups.has(weekKey)) {
				weekGroups.set(weekKey, []);
			}
			weekGroups.get(weekKey)!.push(dateStr);
		}

		// Sort weeks descending
		const sortedWeeks = Array.from(weekGroups.keys()).sort((a, b) => b.localeCompare(a));

		for (const weekKey of sortedWeeks) {
			const weekGroup = container.createDiv('omi-conversation-week-group');

			const weekStart = new Date(weekKey + 'T00:00:00');
			const weekEnd = new Date(weekStart);
			weekEnd.setDate(weekEnd.getDate() + 6);

			const headerText = `Week of ${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
			weekGroup.createEl('div', { text: headerText, cls: 'omi-conversation-week-header' });

			// Get all conversations for this week
			const weekDates = weekGroups.get(weekKey)!;
			const allConvs: SyncedConversationMeta[] = [];
			for (const dateStr of weekDates) {
				const convs = groupedByDate.get(dateStr) || [];
				allConvs.push(...convs);
			}

			// Calculate weekly stats
			const totalDuration = allConvs.reduce((sum, c) => sum + (c.duration || 0), 0);
			const totalTasks = allConvs.reduce((sum, c) => sum + (c.actionItemCount || 0), 0);
			const totalEvents = allConvs.reduce((sum, c) => sum + (c.eventCount || 0), 0);

			const weekStats = weekGroup.createDiv('omi-conversation-week-stats');
			weekStats.createEl('span', { text: `${allConvs.length} conversations` });
			weekStats.createEl('span', { text: `${this.formatDuration(totalDuration)}` });
			weekStats.createEl('span', { text: `${totalTasks} tasks` });
			weekStats.createEl('span', { text: `${totalEvents} events` });

			// Show cards for each conversation
			const cardsContainer = weekGroup.createDiv('omi-conversation-week-cards');
			for (const conv of allConvs.sort((a, b) => b.date.localeCompare(a.date) || this.compareTime(b.time, a.time))) {
				this.renderConversationCard(cardsContainer, conv, true);
			}
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

	// ==================== TIMELINE VIEW ====================

	private renderConversationsTimeline(container: HTMLElement): void {
		const timelineContainer = container.createDiv('omi-conversations-timeline');

		const conversations = this.plugin.settings.syncedConversations || {};
		const conversationArray = Object.values(conversations) as SyncedConversationMeta[];

		if (conversationArray.length === 0) {
			const empty = timelineContainer.createDiv('omi-conversations-empty');
			empty.createEl('div', { text: '⏱️', cls: 'omi-empty-icon' });
			empty.createEl('h3', { text: 'No conversations to display' });
			empty.createEl('p', { text: 'Sync conversations to see your timeline' });
			return;
		}

		const timeRange = this.plugin.settings.conversationsTimeRange || 'daily';

		if (timeRange === 'weekly') {
			this.renderWeeklyTimeline(timelineContainer, conversationArray);
		} else {
			this.renderDailyTimeline(timelineContainer, conversationArray);
		}
	}

	private renderDailyTimeline(container: HTMLElement, conversations: SyncedConversationMeta[]): void {
		// Group by date, show today or most recent day with data
		const groupedByDate = new Map<string, SyncedConversationMeta[]>();
		for (const conv of conversations) {
			if (!groupedByDate.has(conv.date)) {
				groupedByDate.set(conv.date, []);
			}
			groupedByDate.get(conv.date)!.push(conv);
		}

		const sortedDates = Array.from(groupedByDate.keys()).sort((a, b) => b.localeCompare(a));
		const today = this.formatDateOnly(new Date());
		const displayDate = sortedDates.includes(today) ? today : sortedDates[0];

		if (!displayDate) return;

		// Date header with navigation
		const nav = container.createDiv('omi-timeline-nav');
		const prevBtn = nav.createEl('button', { text: '◀', cls: 'omi-timeline-nav-btn' });
		const dateIndex = sortedDates.indexOf(displayDate);

		const dateLabel = nav.createEl('span', {
			text: new Date(displayDate + 'T00:00:00').toLocaleDateString('en-US', {
				weekday: 'long',
				month: 'long',
				day: 'numeric',
				year: 'numeric'
			}),
			cls: 'omi-timeline-date-label'
		});

		const nextBtn = nav.createEl('button', { text: '▶', cls: 'omi-timeline-nav-btn' });

		// For now, just show the most recent day (navigation could be added later)
		prevBtn.disabled = dateIndex >= sortedDates.length - 1;
		nextBtn.disabled = dateIndex <= 0;

		// Timeline hours (6 AM to 11 PM)
		const timeline = container.createDiv('omi-timeline-grid');

		// Hour labels
		const hoursRow = timeline.createDiv('omi-timeline-hours');
		for (let hour = 6; hour <= 23; hour++) {
			const hourLabel = hoursRow.createEl('span', {
				text: hour <= 12 ? `${hour}${hour < 12 ? 'am' : 'pm'}` : `${hour - 12}pm`,
				cls: 'omi-timeline-hour'
			});
		}

		// Timeline track
		const track = timeline.createDiv('omi-timeline-track');
		const dayConvs = groupedByDate.get(displayDate) || [];

		// Place conversation blocks
		for (const conv of dayConvs) {
			this.renderTimelineBlock(track, conv);
		}

		// Legend
		const legend = container.createDiv('omi-timeline-legend');
		legend.createEl('span', { text: `${dayConvs.length} conversations on this day` });
		const totalDuration = dayConvs.reduce((sum, c) => sum + (c.duration || 0), 0);
		legend.createEl('span', { text: `Total time: ${this.formatDuration(totalDuration)}` });
	}

	private renderWeeklyTimeline(container: HTMLElement, conversations: SyncedConversationMeta[]): void {
		// Group by date
		const groupedByDate = new Map<string, SyncedConversationMeta[]>();
		for (const conv of conversations) {
			if (!groupedByDate.has(conv.date)) {
				groupedByDate.set(conv.date, []);
			}
			groupedByDate.get(conv.date)!.push(conv);
		}

		// Find the most recent week with data
		const sortedDates = Array.from(groupedByDate.keys()).sort((a, b) => b.localeCompare(a));
		if (sortedDates.length === 0) return;

		const mostRecentDate = new Date(sortedDates[0] + 'T00:00:00');
		const weekStart = this.getWeekStartDate(mostRecentDate);

		// Week header
		const weekEnd = new Date(weekStart);
		weekEnd.setDate(weekEnd.getDate() + 6);
		container.createEl('div', {
			text: `Week of ${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
			cls: 'omi-timeline-week-header'
		});

		// 7 rows (one per day)
		const weekGrid = container.createDiv('omi-timeline-week-grid');
		const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

		for (let i = 0; i < 7; i++) {
			const dayDate = new Date(weekStart);
			dayDate.setDate(weekStart.getDate() + i);
			const dateStr = this.formatDateOnly(dayDate);

			const dayRow = weekGrid.createDiv('omi-timeline-week-row');

			// Day label
			dayRow.createEl('span', { text: dayNames[i], cls: 'omi-timeline-day-label' });

			// Timeline track for this day
			const track = dayRow.createDiv('omi-timeline-track');
			const dayConvs = groupedByDate.get(dateStr) || [];

			for (const conv of dayConvs) {
				this.renderTimelineBlock(track, conv);
			}
		}

		// Hour markers at bottom
		const hoursRow = weekGrid.createDiv('omi-timeline-hours-footer');
		hoursRow.createEl('span', { text: '', cls: 'omi-timeline-spacer' }); // Spacer for day label column
		for (let hour = 6; hour <= 22; hour += 4) {
			hoursRow.createEl('span', {
				text: hour <= 12 ? `${hour}${hour < 12 ? 'am' : 'pm'}` : `${hour - 12}pm`,
				cls: 'omi-timeline-hour-marker'
			});
		}
	}

	private renderTimelineBlock(track: HTMLElement, conv: SyncedConversationMeta): void {
		// Parse start time
		const startMinutes = this.parseTimeToMinutes(conv.time);
		if (startMinutes < 0) return;

		// Calculate position (6am = 0%, 11pm = 100%)
		const dayStartMinutes = 6 * 60;  // 6 AM
		const dayEndMinutes = 23 * 60;   // 11 PM
		const totalRange = dayEndMinutes - dayStartMinutes;

		const position = Math.max(0, Math.min(100, ((startMinutes - dayStartMinutes) / totalRange) * 100));
		const duration = conv.duration || 15; // Default 15 min if not set
		const width = Math.max(2, Math.min(30, (duration / totalRange) * 100)); // Min 2%, max 30%

		const block = track.createDiv('omi-timeline-block');
		block.style.left = `${position}%`;
		block.style.width = `${width}%`;
		block.setAttribute('title', `${conv.emoji} ${conv.title}\n${conv.time} - ${this.formatDuration(duration)}`);

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

		// Click to open conversation
		block.addEventListener('click', () => this.openConversationFile(conv));
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

		// Calculate stats for this week
		const now = new Date();
		const weekStart = this.getWeekStartDate(now);
		const weekConvs = conversationArray.filter(c => {
			const convDate = new Date(c.date + 'T00:00:00');
			return convDate >= weekStart;
		});

		// Top stats cards
		const topStats = statsContainer.createDiv('omi-stats-top-row');

		// Conversation count
		const countCard = topStats.createDiv('omi-stats-card');
		countCard.createEl('div', { text: String(weekConvs.length), cls: 'omi-stats-value' });
		countCard.createEl('div', { text: 'conversations', cls: 'omi-stats-label' });

		// Total time
		const totalDuration = weekConvs.reduce((sum, c) => sum + (c.duration || 0), 0);
		const timeCard = topStats.createDiv('omi-stats-card');
		timeCard.createEl('div', { text: this.formatDuration(totalDuration), cls: 'omi-stats-value' });
		timeCard.createEl('div', { text: 'total time', cls: 'omi-stats-label' });

		// Top category
		const categoryCount = new Map<string, number>();
		for (const conv of weekConvs) {
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
		const totalTasks = weekConvs.reduce((sum, c) => sum + (c.actionItemCount || 0), 0);
		const tasksCard = topStats.createDiv('omi-stats-card');
		tasksCard.createEl('div', { text: String(totalTasks), cls: 'omi-stats-value' });
		tasksCard.createEl('div', { text: 'tasks created', cls: 'omi-stats-label' });

		// Total events
		const totalEvents = weekConvs.reduce((sum, c) => sum + (c.eventCount || 0), 0);
		const eventsCard = topStats.createDiv('omi-stats-card');
		eventsCard.createEl('div', { text: String(totalEvents), cls: 'omi-stats-value' });
		eventsCard.createEl('div', { text: 'events', cls: 'omi-stats-label' });

		// Category breakdown
		const categorySection = statsContainer.createDiv('omi-stats-section');
		categorySection.createEl('h4', { text: 'Category Breakdown' });

		const categoryDurations = new Map<string, number>();
		for (const conv of weekConvs) {
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
		for (const conv of weekConvs) {
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

		// Find date range (last 12 weeks)
		const now = new Date();
		const endDate = new Date(now);
		endDate.setDate(endDate.getDate() - endDate.getDay() + 6); // End of current week
		const startDate = new Date(endDate);
		startDate.setDate(startDate.getDate() - 12 * 7 + 1); // 12 weeks back

		// Heatmap header with month labels
		const monthsRow = heatmapContainer.createDiv('omi-heatmap-months');
		monthsRow.createEl('span', { text: '', cls: 'omi-heatmap-spacer' }); // Spacer for day labels

		// Add month labels
		let currentMonth = -1;
		const tempDate = new Date(startDate);
		while (tempDate <= endDate) {
			if (tempDate.getMonth() !== currentMonth) {
				currentMonth = tempDate.getMonth();
				monthsRow.createEl('span', {
					text: tempDate.toLocaleDateString('en-US', { month: 'short' }),
					cls: 'omi-heatmap-month'
				});
			}
			tempDate.setDate(tempDate.getDate() + 7);
		}

		// Heatmap grid
		const grid = heatmapContainer.createDiv('omi-heatmap-grid');
		const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

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

				// Click to filter to that day
				if (count > 0) {
					cell.addClass('clickable');
					cell.addEventListener('click', () => {
						// Switch to list view and could scroll to that date
						this.plugin.settings.conversationsViewMode = 'list';
						this.plugin.settings.conversationsTimeRange = 'daily';
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

		summary.createEl('span', { text: `${totalConvs} total conversations` });
		summary.createEl('span', { text: `${activeDays} active days` });
		summary.createEl('span', { text: `${avgPerDay} avg/day` });
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
		} else if (context === 'pending') {
			empty.createEl('div', { text: '🎉', cls: 'omi-empty-icon' });
			empty.createEl('p', { text: 'All caught up!' });
		} else if (context === 'completed') {
			empty.createEl('div', { text: '📋', cls: 'omi-empty-icon' });
			empty.createEl('p', { text: 'No completed tasks yet' });
		} else if (context === 'search') {
			empty.createEl('div', { text: '🔍', cls: 'omi-empty-icon' });
			empty.createEl('p', { text: 'No tasks match your search' });
		}
	}

	private isOverdue(dueAt: string | null): boolean {
		if (!dueAt) return false;
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const dueDate = new Date(dueAt.split('T')[0]);
		return dueDate < today;
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

		// Pending Section
		this.renderSection(container, 'Pending', pending, 'pending');

		// Completed Section
		this.renderSection(container, 'Completed', completed, 'completed');
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

		if (this.kanbanLayout === 'status') {
			this.renderKanbanColumn(board, '⏳ Pending', filtered.filter(t => !t.completed), 'pending');
			this.renderKanbanColumn(board, '✅ Completed', filtered.filter(t => t.completed), 'completed');
		} else {
			const grouped = this.groupTasksByDateColumn(filtered);
			this.renderKanbanColumn(board, '🔴 Overdue', grouped.overdue, 'overdue');
			this.renderKanbanColumn(board, '📌 Today', grouped.today, 'today');
			this.renderKanbanColumn(board, '📆 This Week', grouped.thisWeek, 'thisWeek');
			this.renderKanbanColumn(board, '🔮 Later', grouped.later, 'later');
			this.renderKanbanColumn(board, '❓ No Date', grouped.noDate, 'noDate');
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
		checkbox.addEventListener('change', () => this.toggleTaskCompletion(task));

		// Description
		const desc = card.createEl('div', { text: task.description, cls: 'omi-kanban-card-desc' });
		desc.addEventListener('click', () => {
			// Could open edit modal in future
		});

		// Due date pill
		if (task.dueAt) {
			card.createEl('span', {
				text: `📅 ${this.formatDueDateTime(task.dueAt)}`,
				cls: 'omi-kanban-card-due'
			});
		}
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

	private groupTasksByDateColumn(tasks: TaskWithUI[]): {
		overdue: TaskWithUI[];
		today: TaskWithUI[];
		thisWeek: TaskWithUI[];
		later: TaskWithUI[];
		noDate: TaskWithUI[];
	} {
		const now = new Date();
		now.setHours(0, 0, 0, 0);

		const result = {
			overdue: [] as TaskWithUI[],
			today: [] as TaskWithUI[],
			thisWeek: [] as TaskWithUI[],
			later: [] as TaskWithUI[],
			noDate: [] as TaskWithUI[]
		};

		for (const task of tasks) {
			if (!task.dueAt) {
				result.noDate.push(task);
				continue;
			}

			const dueDate = new Date(task.dueAt.split('T')[0]);
			dueDate.setHours(0, 0, 0, 0);
			const diffDays = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

			if (diffDays < 0) {
				result.overdue.push(task);
			} else if (diffDays === 0) {
				result.today.push(task);
			} else if (diffDays <= 7) {
				result.thisWeek.push(task);
			} else {
				result.later.push(task);
			}
		}

		return result;
	}

	private getDateForColumn(columnId: string): string | null {
		const now = new Date();
		switch (columnId) {
			case 'today':
				return this.formatDateOnly(now);
			case 'thisWeek':
				now.setDate(now.getDate() + 3);
				return this.formatDateOnly(now);
			case 'later':
				now.setDate(now.getDate() + 14);
				return this.formatDateOnly(now);
			case 'noDate':
				return null;
			case 'overdue':
				// Keep existing date for overdue (don't change)
				return this.draggedTask?.dueAt?.split('T')[0] || null;
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

	// ==================== CALENDAR VIEW ====================

	private renderCalendarView(container: HTMLElement): void {
		// View type toggle (Monthly vs Weekly)
		const viewToggle = container.createDiv('omi-calendar-view-toggle');
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
			if (!task.dueAt) return false;
			const taskDate = new Date(task.dueAt.split('T')[0]);
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

	private renderSection(container: HTMLElement, title: string, tasks: TaskWithUI[], sectionId: string): void {
		const section = container.createDiv(`omi-tasks-section omi-tasks-${sectionId}`);

		const isCollapsed = sectionId === 'pending' ? this.pendingCollapsed : this.completedCollapsed;
		const emoji = sectionId === 'pending' ? '⏳' : '✅';

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
			if (sectionId === 'pending') {
				this.pendingCollapsed = !this.pendingCollapsed;
			} else {
				this.completedCollapsed = !this.completedCollapsed;
			}
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
				this.renderTaskRow(taskList, task);
			}

			if (tasks.length === 0) {
				this.renderEmptyState(taskList, sectionId);
			}
		}
	}

	private renderTaskRow(container: HTMLElement, task: TaskWithUI): void {
		const rowClasses = ['omi-task-row'];
		if (task.completed) rowClasses.push('completed');
		const row = container.createDiv(rowClasses.join(' '));
		row.setAttribute('role', 'listitem');
		row.setAttribute('tabindex', '0');

		// Status dot (TaskNotes inspired)
		const isOverdueTask = task.dueAt && this.isOverdue(task.dueAt) && !task.completed;
		let statusClass = 'omi-task__status--pending';
		if (task.completed) {
			statusClass = 'omi-task__status--completed';
		} else if (isOverdueTask) {
			statusClass = 'omi-task__status--overdue';
		}
		const statusDot = row.createDiv(`omi-task__status ${statusClass}`);
		statusDot.setAttribute('aria-hidden', 'true'); // Decorative element

		// Checkbox
		const checkbox = row.createEl('input', { type: 'checkbox' });
		checkbox.checked = task.completed;
		checkbox.setAttribute('aria-label', `Mark "${task.description}" as ${task.completed ? 'pending' : 'completed'}`);
		checkbox.addEventListener('change', async () => {
			// Add completing animation
			row.classList.add('completing');
			await this.toggleTaskCompletion(task);
		});

		// Description (editable)
		const descEl = row.createEl('span', {
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

		// Due date pill
		if (task.dueAt) {
			const isOverdueTask = this.isOverdue(task.dueAt) && !task.completed;
			const duePill = row.createEl('span', {
				text: `📅 ${this.formatDueDateTime(task.dueAt)}`,
				cls: `omi-task-due-pill ${isOverdueTask ? 'overdue' : ''}`
			});
			duePill.setAttribute('aria-label', `Due date: ${task.dueAt}${isOverdueTask ? ' (overdue)' : ''}. Click to change`);
			duePill.addEventListener('click', () => this.showDatePicker(task));
		} else {
			const addDateBtn = row.createEl('span', {
				text: '+ Date',
				cls: 'omi-task-add-date'
			});
			addDateBtn.setAttribute('aria-label', 'Add due date');
			addDateBtn.addEventListener('click', () => this.showDatePicker(task));
		}

		// Source indicator (if from conversation)
		if (task.sourceLink) {
			const sourceEl = row.createEl('span', { text: '💬', cls: 'omi-task-source' });
			sourceEl.title = 'From conversation';
			sourceEl.setAttribute('aria-label', 'Task from conversation');
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