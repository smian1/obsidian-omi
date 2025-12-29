import { App, Modal, Notice } from 'obsidian';
import { TaskWithUI } from './types';

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
