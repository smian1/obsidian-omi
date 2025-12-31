import { normalizePath, Notice } from 'obsidian';
import { ActionItemFromAPI, MemoryFromAPI } from './types';
import { MEMORY_CATEGORY_EMOJI } from './constants';
import type OmiConversationsPlugin from './main';

export class TasksHubSync {
	private plugin: OmiConversationsPlugin;

	constructor(plugin: OmiConversationsPlugin) {
		this.plugin = plugin;
	}

	// Get full path to tasks file (inside the conversations folder)
	public getTasksFilePath(): string {
		const folderPath = this.plugin.settings.folderPath;
		const fileName = this.plugin.settings.tasksHubFilePath;
		return normalizePath(`${folderPath}/${fileName}`);
	}

	generateMarkdown(items: ActionItemFromAPI[]): string {
		const lines: string[] = [];

		// Add header explaining this is read-only backup
		lines.push('# Omi Tasks');
		lines.push('');
		lines.push('> This file is auto-generated for backup/search. Use the **Omi Tasks** view to edit tasks.');
		lines.push('');

		// Separate pending and completed
		const pending = items.filter(item => !item.completed);
		const completed = items.filter(item => item.completed);

		// Sort by created_at (newest first for pending, oldest first for completed)
		pending.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
		completed.sort((a, b) => new Date(a.completed_at || a.created_at).getTime() - new Date(b.completed_at || b.created_at).getTime());

		if (pending.length > 0) {
			lines.push('## ⏳ Pending', '');
			for (const item of pending) {
				lines.push(this.formatTaskLine(item));
			}
			lines.push('');
		}

		if (completed.length > 0) {
			lines.push('## ✅ Completed', '');
			for (const item of completed) {
				lines.push(this.formatTaskLine(item));
			}
			lines.push('');
		}

		if (pending.length === 0 && completed.length === 0) {
			lines.push('*No tasks yet. Add a task by typing:*');
			lines.push('```');
			lines.push('- [ ] Your task here');
			lines.push('```');
		}

		return lines.join('\n');
	}

	private formatTaskLine(item: ActionItemFromAPI): string {
		const checkbox = item.completed ? '[x]' : '[ ]';
		let line = `- ${checkbox} ${item.description}`;

		// Add due date/time with emoji
		if (item.due_at) {
			line += ` 📅 ${this.formatDueAt(item.due_at)}`;
		}

		// Use Obsidian-native comment %%...%% (invisible in ALL view modes)
		line += ` %%id:${item.id}%%`;

		return line;
	}

	// Format due_at from API for display in backup file
	private formatDueAt(isoString: string): string {
		if (isoString.includes('T')) {
			const date = new Date(isoString);
			const year = date.getFullYear();
			const month = String(date.getMonth() + 1).padStart(2, '0');
			const day = String(date.getDate()).padStart(2, '0');
			const hours = date.getHours();
			const minutes = date.getMinutes();
			// Only include time if it's not midnight
			if (hours === 0 && minutes === 0) {
				return `${year}-${month}-${day}`;
			}
			const ampm = hours >= 12 ? 'PM' : 'AM';
			const hour12 = hours % 12 || 12;
			return `${year}-${month}-${day} ${hour12}:${minutes.toString().padStart(2, '0')} ${ampm}`;
		}
		return isoString;
	}

	async pullFromAPI(): Promise<{ count: number; error?: string }> {
		if (!this.plugin.settings.enableTasksHub || !this.plugin.settings.apiKey) {
			return { count: 0 };
		}

		try {
			const items = await this.plugin.api.getAllActionItems();
			await this.writeToFile(items);
			return { count: items.length };
		} catch (error) {
			console.error('Tasks Hub: Error pulling from API:', error);
			new Notice('Failed to sync tasks backup from Omi');
			return { count: 0, error: error instanceof Error ? error.message : 'Unknown error' };
		}
	}

	private async writeToFile(items: ActionItemFromAPI[]): Promise<void> {
		const filePath = this.getTasksFilePath();
		const content = this.generateMarkdown(items);

		const existingFile = this.plugin.app.vault.getFileByPath(filePath);
		if (existingFile) {
			await this.plugin.app.vault.modify(existingFile, content);
		} else {
			await this.plugin.app.vault.create(filePath, content);
		}
	}
}

export class MemoriesHubSync {
	private plugin: OmiConversationsPlugin;

	constructor(plugin: OmiConversationsPlugin) {
		this.plugin = plugin;
	}

	// Get full path to memories file (inside the conversations folder)
	public getMemoriesFilePath(): string {
		const folderPath = this.plugin.settings.folderPath;
		const fileName = this.plugin.settings.memoriesHubFilePath;
		return normalizePath(`${folderPath}/${fileName}`);
	}

	generateMarkdown(memories: MemoryFromAPI[]): string {
		const lines: string[] = [];

		// Add header explaining this is read-only backup
		lines.push('# Omi Memories');
		lines.push('');
		lines.push('> This file is auto-generated for backup/search. Use the **Omi Memories** view to edit.');
		lines.push('');

		if (memories.length === 0) {
			lines.push('*No memories yet.*');
			return lines.join('\n');
		}

		// Group by category
		const byCategory = this.groupByCategory(memories);

		// Sort categories by count (most memories first)
		const sortedCategories = Object.entries(byCategory)
			.sort((a, b) => b[1].length - a[1].length);

		for (const [category, mems] of sortedCategories) {
			const emoji = MEMORY_CATEGORY_EMOJI[category] || '📌';
			lines.push(`## ${emoji} ${this.capitalizeFirst(category)}`);
			lines.push('');
			for (const mem of mems) {
				lines.push(this.formatMemoryLine(mem));
			}
			lines.push('');
		}

		return lines.join('\n');
	}

	private formatMemoryLine(memory: MemoryFromAPI): string {
		const date = new Date(memory.created_at).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});

		// Format tags with #omi/ prefix
		const tags = memory.tags.length > 0
			? ' ' + memory.tags.map(t => `#omi/${t.toLowerCase().replace(/\s+/g, '-')}`).join(' ')
			: '';

		// Use Obsidian-native comment %%...%% for invisible ID
		return `- ${memory.content}${tags} *(${date})* %%id:${memory.id}%%`;
	}

	private groupByCategory(memories: MemoryFromAPI[]): Record<string, MemoryFromAPI[]> {
		const groups: Record<string, MemoryFromAPI[]> = {};
		for (const mem of memories) {
			const cat = mem.category || 'other';
			if (!groups[cat]) groups[cat] = [];
			groups[cat].push(mem);
		}
		// Sort each group by created_at (newest first)
		for (const cat of Object.keys(groups)) {
			groups[cat].sort((a, b) =>
				new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
			);
		}
		return groups;
	}

	private capitalizeFirst(str: string): string {
		return str.charAt(0).toUpperCase() + str.slice(1);
	}

	async pullFromAPI(): Promise<{ count: number; error?: string }> {
		if (!this.plugin.settings.apiKey) {
			return { count: 0 };
		}

		try {
			const memories = await this.plugin.api.getAllMemories(this.plugin.settings.memoriesFetchLimit);
			await this.writeToFile(memories);
			return { count: memories.length };
		} catch (error) {
			console.error('Memories Hub: Error pulling from API:', error);
			new Notice('Failed to sync memories backup from Omi');
			return { count: 0, error: error instanceof Error ? error.message : 'Unknown error' };
		}
	}

	private async writeToFile(memories: MemoryFromAPI[]): Promise<void> {
		const filePath = this.getMemoriesFilePath();
		const content = this.generateMarkdown(memories);

		const existingFile = this.plugin.app.vault.getFileByPath(filePath);
		if (existingFile) {
			await this.plugin.app.vault.modify(existingFile, content);
		} else {
			// Ensure folder exists
			const folderPath = this.plugin.settings.folderPath;
			const folder = this.plugin.app.vault.getFolderByPath(folderPath);
			if (!folder) {
				await this.plugin.app.vault.createFolder(folderPath);
			}
			await this.plugin.app.vault.create(filePath, content);
		}
	}
}
