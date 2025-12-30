import { App, Modal, Notice } from 'obsidian';
import { TaskWithUI, MemoryWithUI, Achievement } from './types';
import { MEMORY_CATEGORY_EMOJI } from './constants';

export class ConfirmSyncModal extends Modal {
	title: string;
	message: string;
	onConfirm: (fullResync: boolean) => void;
	showSyncOptions: boolean;
	private selectedMode: 'incremental' | 'full' = 'incremental';

	constructor(app: App, title: string, message: string, onConfirm: (fullResync: boolean) => void, showSyncOptions = true) {
		super(app);
		this.title = title;
		this.message = message;
		this.onConfirm = onConfirm;
		this.showSyncOptions = showSyncOptions;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('omi-confirm-modal');

		contentEl.createEl('h3', { text: this.title });
		contentEl.createEl('p', { text: this.message });

		// Add sync mode radio buttons if showing options
		if (this.showSyncOptions) {
			const optionsContainer = contentEl.createDiv('omi-sync-options');

			// Incremental sync option (default)
			const incrementalLabel = optionsContainer.createEl('label', { cls: 'omi-sync-option' });
			const incrementalRadio = incrementalLabel.createEl('input', { type: 'radio' });
			incrementalRadio.name = 'syncMode';
			incrementalRadio.value = 'incremental';
			incrementalRadio.checked = true;
			incrementalLabel.createEl('span', { text: 'Sync new conversations only', cls: 'omi-option-label' });
			incrementalLabel.createEl('span', { text: 'Only fetch conversations added since last sync', cls: 'omi-option-desc' });

			// Full resync option
			const fullLabel = optionsContainer.createEl('label', { cls: 'omi-sync-option' });
			const fullRadio = fullLabel.createEl('input', { type: 'radio' });
			fullRadio.name = 'syncMode';
			fullRadio.value = 'full';
			fullLabel.createEl('span', { text: 'Full resync', cls: 'omi-option-label' });
			fullLabel.createEl('span', { text: 'Refetch all conversations from start date', cls: 'omi-option-desc' });

			// Handle radio changes
			incrementalRadio.addEventListener('change', () => {
				if (incrementalRadio.checked) this.selectedMode = 'incremental';
			});
			fullRadio.addEventListener('change', () => {
				if (fullRadio.checked) this.selectedMode = 'full';
			});
		}

		const buttonContainer = contentEl.createDiv('omi-modal-buttons');

		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const confirmBtn = buttonContainer.createEl('button', { text: 'Sync', cls: 'mod-cta' });
		confirmBtn.addEventListener('click', () => {
			this.close();
			this.onConfirm(this.selectedMode === 'full');
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class AddTaskModal extends Modal {
	onSubmit: (description: string, dueDateTime?: string) => void;

	constructor(app: App, onSubmit: (description: string, dueDateTime?: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('omi-add-task-modal');

		contentEl.createEl('h3', { text: 'Add new task' });

		// Description input
		const descContainer = contentEl.createDiv('omi-modal-field');
		descContainer.createEl('label', { text: 'Description' });
		const descInput = descContainer.createEl('input', {
			type: 'text',
			placeholder: 'Enter task description...'
		});
		descInput.addClass('omi-modal-input');

		// Due date input
		const dateContainer = contentEl.createDiv('omi-modal-field');
		dateContainer.createEl('label', { text: 'Due date (optional)' });
		const dateInput = dateContainer.createEl('input', { type: 'date' });
		dateInput.addClass('omi-modal-input');

		// Due time input
		const timeContainer = contentEl.createDiv('omi-modal-field');
		timeContainer.createEl('label', { text: 'Due time (optional)' });
		const timeInput = timeContainer.createEl('input', { type: 'time' });
		timeInput.addClass('omi-modal-input');

		// Buttons
		const btnContainer = contentEl.createDiv('modal-button-container');

		const saveBtn = btnContainer.createEl('button', { text: 'Add Task', cls: 'mod-cta' });
		saveBtn.addEventListener('click', () => {
			const description = descInput.value.trim();
			if (description.length >= 3) {
				let dueDateTime: string | undefined;
				if (dateInput.value) {
					if (timeInput.value) {
						dueDateTime = `${dateInput.value}T${timeInput.value}`;
					} else {
						dueDateTime = dateInput.value;
					}
				}
				this.onSubmit(description, dueDateTime);
				this.close();
			} else {
				new Notice('Description must be at least 3 characters');
			}
		});

		const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		// Focus description input
		descInput.focus();

		// Handle Enter key
		descInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				saveBtn.click();
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class DatePickerModal extends Modal {
	currentDateTime: string | null;  // Can be "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"
	onSubmit: (dateTime: string | null) => void;

	constructor(app: App, currentDateTime: string | null, onSubmit: (dateTime: string | null) => void) {
		super(app);
		this.currentDateTime = currentDateTime;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('omi-date-picker-modal');

		contentEl.createEl('h3', { text: 'Set due date & time' });

		// Parse existing date/time
		let existingDate = '';
		let existingTime = '';
		if (this.currentDateTime) {
			if (this.currentDateTime.includes('T')) {
				const [date, time] = this.currentDateTime.split('T');
				existingDate = date;
				existingTime = time.substring(0, 5);  // HH:MM
			} else {
				existingDate = this.currentDateTime;
			}
		}

		// Date input
		const dateContainer = contentEl.createDiv('omi-modal-field');
		dateContainer.createEl('label', { text: 'Date' });
		const dateInput = dateContainer.createEl('input', { type: 'date' });
		dateInput.addClass('omi-modal-input');
		dateInput.value = existingDate;

		// Time input
		const timeContainer = contentEl.createDiv('omi-modal-field');
		timeContainer.createEl('label', { text: 'Time (optional)' });
		const timeInput = timeContainer.createEl('input', { type: 'time' });
		timeInput.addClass('omi-modal-input');
		timeInput.value = existingTime;

		const btnContainer = contentEl.createDiv('modal-button-container');

		const saveBtn = btnContainer.createEl('button', { text: 'Save', cls: 'mod-cta' });
		saveBtn.addEventListener('click', () => {
			if (!dateInput.value) {
				this.onSubmit(null);
			} else if (timeInput.value) {
				// Combine date and time
				this.onSubmit(`${dateInput.value}T${timeInput.value}`);
			} else {
				// Date only
				this.onSubmit(dateInput.value);
			}
			this.close();
		});

		const clearBtn = btnContainer.createEl('button', { text: 'Clear' });
		clearBtn.addEventListener('click', () => {
			this.onSubmit(null);
			this.close();
		});

		const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		dateInput.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class EditTaskModal extends Modal {
	task: TaskWithUI;
	onSave: (updates: { description?: string; dueAt?: string | null }) => void;
	onDelete: () => void;

	constructor(
		app: App,
		task: TaskWithUI,
		onSave: (updates: { description?: string; dueAt?: string | null }) => void,
		onDelete: () => void
	) {
		super(app);
		this.task = task;
		this.onSave = onSave;
		this.onDelete = onDelete;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('omi-edit-task-modal');

		contentEl.createEl('h3', { text: 'Edit task' });

		// Description input
		const descContainer = contentEl.createDiv('omi-modal-field');
		descContainer.createEl('label', { text: 'Description' });
		const descInput = descContainer.createEl('textarea', {
			placeholder: 'Task description...'
		});
		descInput.addClass('omi-modal-input', 'omi-modal-textarea');
		descInput.value = this.task.description;
		descInput.rows = 3;

		// Parse existing date/time
		let existingDate = '';
		let existingTime = '';
		if (this.task.dueAt) {
			if (this.task.dueAt.includes('T')) {
				const [date, time] = this.task.dueAt.split('T');
				existingDate = date;
				existingTime = time.substring(0, 5);
			} else {
				existingDate = this.task.dueAt;
			}
		}

		// Due date input
		const dateContainer = contentEl.createDiv('omi-modal-field');
		dateContainer.createEl('label', { text: 'Due date' });
		const dateInput = dateContainer.createEl('input', { type: 'date' });
		dateInput.addClass('omi-modal-input');
		dateInput.value = existingDate;

		// Due time input
		const timeContainer = contentEl.createDiv('omi-modal-field');
		timeContainer.createEl('label', { text: 'Due time' });
		const timeInput = timeContainer.createEl('input', { type: 'time' });
		timeInput.addClass('omi-modal-input');
		timeInput.value = existingTime;

		// Buttons
		const btnContainer = contentEl.createDiv('modal-button-container');

		const saveBtn = btnContainer.createEl('button', { text: 'Save', cls: 'mod-cta' });
		saveBtn.addEventListener('click', () => {
			const description = descInput.value.trim();
			if (description.length < 3) {
				new Notice('Description must be at least 3 characters');
				return;
			}

			let dueAt: string | null = null;
			if (dateInput.value) {
				if (timeInput.value) {
					dueAt = `${dateInput.value}T${timeInput.value}`;
				} else {
					dueAt = dateInput.value;
				}
			}

			this.onSave({ description, dueAt });
			this.close();
		});

		const deleteBtn = btnContainer.createEl('button', { text: 'Delete', cls: 'mod-warning' });
		deleteBtn.addEventListener('click', () => {
			if (confirm('Delete this task?')) {
				this.onDelete();
				this.close();
			}
		});

		const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		// Focus description
		descInput.focus();
		descInput.setSelectionRange(descInput.value.length, descInput.value.length);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class AddMemoryModal extends Modal {
	onSubmit: (content: string, category: string, tags: string[]) => void;
	availableTags: string[];
	selectedTags: string[] = [];

	constructor(app: App, availableTags: string[], onSubmit: (content: string, category: string, tags: string[]) => void) {
		super(app);
		this.availableTags = availableTags;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('omi-add-memory-modal');

		contentEl.createEl('h3', { text: 'Add new memory' });

		// Content textarea
		const contentContainer = contentEl.createDiv('omi-modal-field');
		contentContainer.createEl('label', { text: 'Memory content' });
		const contentInput = contentContainer.createEl('textarea', {
			placeholder: 'Enter memory content (1-500 characters)...'
		});
		contentInput.addClass('omi-modal-input', 'omi-modal-textarea');
		contentInput.rows = 4;

		// Character count
		const charCount = contentContainer.createEl('span', { cls: 'omi-char-count' });
		charCount.setText('0/500');
		contentInput.addEventListener('input', () => {
			const len = contentInput.value.length;
			charCount.setText(`${len}/500`);
			charCount.toggleClass('omi-char-count-warning', len > 450);
			charCount.toggleClass('omi-char-count-error', len > 500);
		});

		// Category dropdown
		const categoryContainer = contentEl.createDiv('omi-modal-field');
		categoryContainer.createEl('label', { text: 'Category' });
		const categorySelect = categoryContainer.createEl('select');
		categorySelect.addClass('omi-modal-input');

		const categories = Object.keys(MEMORY_CATEGORY_EMOJI);
		for (const cat of categories) {
			const emoji = MEMORY_CATEGORY_EMOJI[cat];
			const option = categorySelect.createEl('option', {
				value: cat,
				text: `${emoji} ${cat}`
			});
			if (cat === 'manual') option.selected = true;
		}

		// Tags input
		const tagsContainer = contentEl.createDiv('omi-modal-field');
		tagsContainer.createEl('label', { text: 'Tags (optional)' });

		const tagsInputWrapper = tagsContainer.createDiv('omi-tags-input-wrapper');
		const selectedTagsDiv = tagsInputWrapper.createDiv('omi-selected-tags');

		const tagInputRow = tagsInputWrapper.createDiv('omi-tag-input-row');
		const tagInput = tagInputRow.createEl('input', {
			type: 'text',
			placeholder: 'Type to add tags...'
		});
		tagInput.addClass('omi-tag-input');

		const suggestionsDiv = tagsContainer.createDiv('omi-tag-suggestions');
		suggestionsDiv.style.display = 'none';

		const renderSelectedTags = () => {
			selectedTagsDiv.empty();
			for (const tag of this.selectedTags) {
				const pill = selectedTagsDiv.createDiv('omi-tag-pill-removable');
				pill.createSpan({ text: tag });
				const removeBtn = pill.createSpan({ text: '×', cls: 'omi-tag-remove' });
				removeBtn.addEventListener('click', () => {
					this.selectedTags = this.selectedTags.filter(t => t !== tag);
					renderSelectedTags();
				});
			}
		};

		const addTag = (tag: string) => {
			const normalizedTag = tag.trim().toLowerCase();
			if (normalizedTag && !this.selectedTags.includes(normalizedTag)) {
				this.selectedTags.push(normalizedTag);
				renderSelectedTags();
			}
			tagInput.value = '';
			suggestionsDiv.style.display = 'none';
		};

		const showSuggestions = (filter: string) => {
			suggestionsDiv.empty();
			const lowerFilter = filter.toLowerCase().trim();

			// Get available tags that haven't been selected yet
			const availableUnselected = this.availableTags
				.filter(t => !this.selectedTags.includes(t.toLowerCase()));

			// Filter by search term if provided
			const matches = lowerFilter
				? availableUnselected.filter(t => t.toLowerCase().includes(lowerFilter))
				: availableUnselected;

			// Limit display to 10 tags
			const displayTags = matches.slice(0, 10);

			if (displayTags.length > 0) {
				for (const tag of displayTags) {
					const option = suggestionsDiv.createDiv('omi-tag-suggestion');
					option.setText(tag);
					option.addEventListener('click', () => addTag(tag));
				}
				suggestionsDiv.style.display = 'block';
			} else if (lowerFilter) {
				// No matches but user typed something - show create option
				const createOption = suggestionsDiv.createDiv('omi-tag-suggestion omi-tag-suggestion-new');
				createOption.setText(`Create "${filter.trim()}"`);
				createOption.addEventListener('click', () => addTag(filter.trim()));
				suggestionsDiv.style.display = 'block';
			} else {
				// No tags available at all
				suggestionsDiv.style.display = 'none';
			}
		};

		tagInput.addEventListener('input', () => {
			showSuggestions(tagInput.value);
		});

		tagInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				if (tagInput.value.trim()) {
					addTag(tagInput.value.trim());
				}
			} else if (e.key === 'Backspace' && tagInput.value === '' && this.selectedTags.length > 0) {
				this.selectedTags.pop();
				renderSelectedTags();
			} else if (e.key === 'Escape') {
				suggestionsDiv.style.display = 'none';
			}
		});

		// Hide suggestions when clicking outside
		tagInput.addEventListener('blur', () => {
			setTimeout(() => {
				suggestionsDiv.style.display = 'none';
			}, 200);
		});

		// Show all tags when focusing (even with empty input)
		tagInput.addEventListener('focus', () => {
			showSuggestions(tagInput.value);
		});

		// Buttons
		const btnContainer = contentEl.createDiv('modal-button-container');

		const saveBtn = btnContainer.createEl('button', { text: 'Add Memory', cls: 'mod-cta' });
		saveBtn.addEventListener('click', () => {
			const content = contentInput.value.trim();
			if (content.length < 1) {
				new Notice('Memory content cannot be empty');
				return;
			}
			if (content.length > 500) {
				new Notice('Memory content must be 500 characters or less');
				return;
			}
			this.onSubmit(content, categorySelect.value, this.selectedTags);
			this.close();
		});

		const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		// Focus content input
		contentInput.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class EditMemoryModal extends Modal {
	memory: MemoryWithUI;
	onSave: (updates: { content?: string; category?: string; visibility?: 'public' | 'private' }) => void;
	onDelete: () => void;

	constructor(
		app: App,
		memory: MemoryWithUI,
		onSave: (updates: { content?: string; category?: string; visibility?: 'public' | 'private' }) => void,
		onDelete: () => void
	) {
		super(app);
		this.memory = memory;
		this.onSave = onSave;
		this.onDelete = onDelete;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('omi-edit-memory-modal');

		contentEl.createEl('h3', { text: 'Edit memory' });

		// Content textarea
		const contentContainer = contentEl.createDiv('omi-modal-field');
		contentContainer.createEl('label', { text: 'Memory content' });
		const contentInput = contentContainer.createEl('textarea', {
			placeholder: 'Enter memory content...'
		});
		contentInput.addClass('omi-modal-input', 'omi-modal-textarea');
		contentInput.value = this.memory.content;
		contentInput.rows = 4;

		// Character count
		const charCount = contentContainer.createEl('span', { cls: 'omi-char-count' });
		charCount.setText(`${this.memory.content.length}/500`);
		contentInput.addEventListener('input', () => {
			const len = contentInput.value.length;
			charCount.setText(`${len}/500`);
			charCount.toggleClass('omi-char-count-warning', len > 450);
			charCount.toggleClass('omi-char-count-error', len > 500);
		});

		// Category dropdown
		const categoryContainer = contentEl.createDiv('omi-modal-field');
		categoryContainer.createEl('label', { text: 'Category' });
		const categorySelect = categoryContainer.createEl('select');
		categorySelect.addClass('omi-modal-input');

		const categories = Object.keys(MEMORY_CATEGORY_EMOJI);
		for (const cat of categories) {
			const emoji = MEMORY_CATEGORY_EMOJI[cat];
			const option = categorySelect.createEl('option', {
				value: cat,
				text: `${emoji} ${cat}`
			});
			if (cat === this.memory.category) option.selected = true;
		}

		// Visibility dropdown
		const visibilityContainer = contentEl.createDiv('omi-modal-field');
		visibilityContainer.createEl('label', { text: 'Visibility' });
		const visibilitySelect = visibilityContainer.createEl('select');
		visibilitySelect.addClass('omi-modal-input');

		const privateOption = visibilitySelect.createEl('option', { value: 'private', text: '🔒 Private' });
		const publicOption = visibilitySelect.createEl('option', { value: 'public', text: '🌐 Public' });
		if (this.memory.visibility === 'public') {
			publicOption.selected = true;
		} else {
			privateOption.selected = true;
		}

		// Tags display (read-only)
		if (this.memory.tags && this.memory.tags.length > 0) {
			const tagsContainer = contentEl.createDiv('omi-modal-field');
			tagsContainer.createEl('label', { text: 'Tags (auto-generated)' });
			const tagsDiv = tagsContainer.createDiv('omi-memory-tags-display');
			for (const tag of this.memory.tags) {
				tagsDiv.createEl('span', { text: tag, cls: 'omi-tag-pill' });
			}
		}

		// Buttons
		const btnContainer = contentEl.createDiv('modal-button-container');

		const saveBtn = btnContainer.createEl('button', { text: 'Save', cls: 'mod-cta' });
		saveBtn.addEventListener('click', () => {
			const content = contentInput.value.trim();
			if (content.length < 1) {
				new Notice('Memory content cannot be empty');
				return;
			}
			if (content.length > 500) {
				new Notice('Memory content must be 500 characters or less');
				return;
			}

			const updates: { content?: string; category?: string; visibility?: 'public' | 'private' } = {};

			if (content !== this.memory.content) {
				updates.content = content;
			}
			if (categorySelect.value !== this.memory.category) {
				updates.category = categorySelect.value;
			}
			if (visibilitySelect.value !== this.memory.visibility) {
				updates.visibility = visibilitySelect.value as 'public' | 'private';
			}

			if (Object.keys(updates).length > 0) {
				this.onSave(updates);
			}
			this.close();
		});

		const deleteBtn = btnContainer.createEl('button', { text: 'Delete', cls: 'mod-warning' });
		deleteBtn.addEventListener('click', () => {
			if (confirm('Delete this memory? This action cannot be undone.')) {
				this.onDelete();
				this.close();
			}
		});

		const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		// Focus content
		contentInput.focus();
		contentInput.setSelectionRange(contentInput.value.length, contentInput.value.length);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class CalendarDatePickerModal extends Modal {
	currentMonth: Date;
	selectedDate: string;
	datesWithData: Set<string>;
	onSelect: (date: string) => void;

	constructor(
		app: App,
		datesWithData: string[],
		selectedDate: string,
		onSelect: (date: string) => void
	) {
		super(app);
		this.datesWithData = new Set(datesWithData);
		this.selectedDate = selectedDate;
		this.currentMonth = new Date(selectedDate + 'T00:00:00');
		this.onSelect = onSelect;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('omi-calendar-picker-modal');
		this.renderCalendar();
	}

	private renderCalendar(): void {
		const { contentEl } = this;
		contentEl.empty();

		// Month header with navigation
		const header = contentEl.createDiv('omi-calendar-picker-header');

		const prevBtn = header.createEl('button', { text: '◀', cls: 'omi-calendar-nav-btn' });
		prevBtn.addEventListener('click', () => this.navigateMonth(-1));

		header.createEl('span', {
			text: this.currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
			cls: 'omi-calendar-month-label'
		});

		const nextBtn = header.createEl('button', { text: '▶', cls: 'omi-calendar-nav-btn' });
		nextBtn.addEventListener('click', () => this.navigateMonth(1));

		// Quick jump buttons
		const quickNav = contentEl.createDiv('omi-calendar-quick-nav');

		const todayBtn = quickNav.createEl('button', { text: 'Today', cls: 'omi-calendar-quick-btn' });
		todayBtn.addEventListener('click', () => {
			const today = new Date();
			const todayStr = this.formatDate(today);
			if (this.datesWithData.has(todayStr)) {
				this.onSelect(todayStr);
				this.close();
			} else {
				// Jump to today's month at least
				this.currentMonth = today;
				this.renderCalendar();
			}
		});

		const recentBtn = quickNav.createEl('button', { text: 'Most Recent', cls: 'omi-calendar-quick-btn' });
		recentBtn.addEventListener('click', () => {
			// Find most recent date with data
			const sortedDates = Array.from(this.datesWithData).sort((a, b) => b.localeCompare(a));
			if (sortedDates.length > 0) {
				this.onSelect(sortedDates[0]);
				this.close();
			}
		});

		// Day labels
		const dayLabels = contentEl.createDiv('omi-calendar-day-labels');
		const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		for (const day of days) {
			dayLabels.createEl('span', { text: day, cls: 'omi-calendar-day-label' });
		}

		// Calendar grid
		const grid = contentEl.createDiv('omi-calendar-picker-grid');

		const year = this.currentMonth.getFullYear();
		const month = this.currentMonth.getMonth();

		// First day of month
		const firstDay = new Date(year, month, 1);
		const startPadding = firstDay.getDay();

		// Last day of month
		const lastDay = new Date(year, month + 1, 0);
		const daysInMonth = lastDay.getDate();

		// Today for highlighting
		const today = this.formatDate(new Date());

		// Add padding days from previous month
		for (let i = 0; i < startPadding; i++) {
			const paddingDay = grid.createDiv('omi-calendar-day omi-calendar-day-padding');
			const prevMonthDay = new Date(year, month, -startPadding + i + 1);
			paddingDay.setText(String(prevMonthDay.getDate()));
		}

		// Add days of current month
		for (let day = 1; day <= daysInMonth; day++) {
			const dateStr = this.formatDate(new Date(year, month, day));
			const hasData = this.datesWithData.has(dateStr);
			const isSelected = dateStr === this.selectedDate;
			const isToday = dateStr === today;

			const classes = ['omi-calendar-day'];
			if (hasData) classes.push('has-data');
			if (isSelected) classes.push('selected');
			if (isToday) classes.push('today');

			const dayEl = grid.createDiv(classes.join(' '));
			dayEl.setText(String(day));
			dayEl.setAttribute('role', 'button');
			dayEl.setAttribute('tabindex', '0');

			if (hasData) {
				dayEl.addEventListener('click', () => {
					this.onSelect(dateStr);
					this.close();
				});
				dayEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						this.onSelect(dateStr);
						this.close();
					}
				});
			}
		}
	}

	private navigateMonth(delta: number): void {
		this.currentMonth.setMonth(this.currentMonth.getMonth() + delta);
		this.renderCalendar();
	}

	private formatDate(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class AchievementsModal extends Modal {
	achievements: Achievement[];

	constructor(app: App, achievements: Achievement[]) {
		super(app);
		this.achievements = achievements;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('omi-achievements-modal');

		contentEl.createEl('h3', { text: '🏆 Achievements' });

		const desc = contentEl.createEl('p', { cls: 'omi-achievements-desc' });
		desc.setText('Track your Omi journey with these milestones. Keep using Omi to unlock more!');

		const grid = contentEl.createDiv('omi-achievements-grid');

		// Separate unlocked and locked
		const unlocked = this.achievements.filter(a => a.unlocked);
		const locked = this.achievements.filter(a => !a.unlocked);

		// Render unlocked first
		for (const achievement of unlocked) {
			this.renderAchievementCard(grid, achievement);
		}

		// Render locked
		for (const achievement of locked) {
			this.renderAchievementCard(grid, achievement);
		}

		// Close button
		const btnContainer = contentEl.createDiv('modal-button-container');
		const closeBtn = btnContainer.createEl('button', { text: 'Close', cls: 'mod-cta' });
		closeBtn.addEventListener('click', () => this.close());
	}

	private renderAchievementCard(container: HTMLElement, achievement: Achievement): void {
		const card = container.createDiv(`omi-achievement-card ${achievement.unlocked ? 'unlocked' : 'locked'}`);

		const iconEl = card.createDiv('omi-achievement-icon');
		iconEl.setText(achievement.icon);

		const info = card.createDiv('omi-achievement-info');
		info.createEl('span', { text: achievement.title, cls: 'omi-achievement-title' });
		info.createEl('span', { text: achievement.description, cls: 'omi-achievement-description' });

		// Progress bar for locked achievements
		if (!achievement.unlocked && achievement.threshold && achievement.current !== undefined) {
			const progressContainer = card.createDiv('omi-achievement-progress-container');
			const progressBar = progressContainer.createDiv('omi-achievement-progress-bar');
			const progressFill = progressBar.createDiv('omi-achievement-progress-fill');
			const progressPct = Math.min((achievement.current / achievement.threshold) * 100, 100);
			progressFill.style.width = `${progressPct}%`;

			progressContainer.createEl('span', {
				text: `${achievement.current} / ${achievement.threshold}`,
				cls: 'omi-achievement-progress-text'
			});
		}

		// Unlocked badge
		if (achievement.unlocked) {
			const badge = card.createDiv('omi-achievement-unlocked-badge');
			badge.setText('✓ Unlocked');
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
