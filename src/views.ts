import { ItemView, WorkspaceLeaf, Notice, debounce } from 'obsidian';
import { VIEW_TYPE_OMI_TASKS } from './constants';
import { TaskWithUI } from './types';
import { AddTaskModal, DatePickerModal, EditTaskModal } from './modals';
import type OmiConversationsPlugin from './main';

export class OmiTasksView extends ItemView {
	plugin: OmiConversationsPlugin;
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
		return VIEW_TYPE_OMI_TASKS;
	}

	getDisplayText(): string {
		return 'Omi Tasks';
	}

	getIcon(): string {
		return 'check-circle';
	}

	async onOpen(): Promise<void> {
		// Load saved view preferences
		this.viewMode = this.plugin.settings.tasksViewMode || 'list';
		this.kanbanLayout = this.plugin.settings.tasksKanbanLayout || 'status';
		this.calendarViewType = this.plugin.settings.tasksCalendarType || 'monthly';

		await this.loadTasks();
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
		container.addClass('omi-tasks-container');

		// Header
		const header = container.createDiv('omi-tasks-header');
		header.createEl('h2', { text: 'Omi Tasks' });

		// View Mode Tabs
		this.renderViewModeTabs(container);

		// Toolbar: Search + Sync button
		const toolbar = container.createDiv('omi-tasks-toolbar');
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
			this.renderLoadingSkeleton(container);
			return;
		}

		// Show empty state if no tasks
		if (this.tasks.length === 0) {
			this.renderEmptyState(container, 'all');
			// Still show add button
			const addBtn = container.createEl('button', { text: '+ Add Task', cls: 'omi-tasks-add-btn' });
			addBtn.setAttribute('aria-label', 'Add new task');
			addBtn.addEventListener('click', () => this.showAddTaskDialog());
			return;
		}

		// Render the appropriate view based on viewMode
		switch (this.viewMode) {
			case 'list':
				this.renderListView(container);
				break;
			case 'kanban':
				this.renderKanbanView(container);
				break;
			case 'calendar':
				this.renderCalendarView(container);
				break;
		}

		// Add new task button
		const addBtn = container.createEl('button', { text: '+ Add Task', cls: 'omi-tasks-add-btn' });
		addBtn.setAttribute('aria-label', 'Add new task');
		addBtn.addEventListener('click', () => this.showAddTaskDialog());
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

	private getWeekStartDate(): Date {
		const date = new Date(this.calendarCurrentDate);
		const day = date.getDay();
		date.setDate(date.getDate() - day); // Go to Sunday
		return date;
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