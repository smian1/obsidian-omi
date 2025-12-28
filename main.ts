import { App, Plugin, PluginSettingTab, Setting, normalizePath, Notice, requestUrl, ItemView, WorkspaceLeaf, Modal } from 'obsidian';

// View type constant for Omi Tasks custom view
const VIEW_TYPE_OMI_TASKS = 'omi-tasks-view';

interface OmiConversationsSettings {
	apiKey: string;
	folderPath: string;
	startDate: string;
	includeOverview: boolean;
	includeActionItems: boolean;
	includeEvents: boolean;
	includeTranscript: boolean;
	// Tasks Hub settings
	enableTasksHub: boolean;
	tasksHubFilePath: string;
	tasksHubSyncInterval: number;
	tasksViewAutoRefresh: number;  // Auto-refresh interval for tasks view (minutes, 0 = disabled)
	// Tasks View preferences (persisted)
	tasksViewMode: 'list' | 'kanban' | 'calendar';
	tasksKanbanLayout: 'status' | 'date';
	tasksCalendarType: 'monthly' | 'weekly';
}

// Omi API response types
interface ActionItem {
	description: string;
	completed: boolean;
}

interface CalendarEvent {
	title: string;
	start: string;
	duration: number;
	description?: string;
}

interface TranscriptSegment {
	speaker?: string;
	speaker_id?: number;
	start: number;
	text: string;
}

interface StructuredData {
	title?: string;
	emoji?: string;
	category?: string;
	overview?: string;
	action_items?: ActionItem[];
	events?: CalendarEvent[];
}

interface Conversation {
	id: string;
	created_at: string;
	started_at: string;
	finished_at: string;
	structured?: StructuredData;
	transcript_segments?: TranscriptSegment[];
}

// Action Item API types (for Tasks Hub)
interface ActionItemFromAPI {
	id: string;
	description: string;
	completed: boolean;
	created_at: string;
	updated_at: string;
	due_at: string | null;
	completed_at: string | null;
	conversation_id: string | null;
}

interface ParsedTask {
	completed: boolean;
	description: string;
	dueAt: string | null;
	sourceLink: string | null;
	id: string | null;
	lineIndex: number;
}

const DEFAULT_SETTINGS: OmiConversationsSettings = {
	apiKey: '',
	folderPath: 'Omi Conversations',
	startDate: '2025-02-09',
	includeOverview: true,
	includeActionItems: true,
	includeEvents: true,
	includeTranscript: true,
	// Tasks Hub defaults
	enableTasksHub: false,
	tasksHubFilePath: 'Tasks.md',  // Relative to folderPath
	tasksHubSyncInterval: 5,
	tasksViewAutoRefresh: 10,  // Auto-refresh every 10 minutes by default
	// Tasks View preferences defaults
	tasksViewMode: 'list',
	tasksKanbanLayout: 'status',
	tasksCalendarType: 'monthly'
}

// Helper function to get emoji based on category
function getCategoryEmoji(category: string): string {
	const emojiMap: Record<string, string> = {
		'personal': '🙋',
		'education': '📚',
		'health': '🏥',
		'finance': '💰',
		'legal': '⚖️',
		'philosophy': '🤔',
		'spiritual': '🙏',
		'science': '🔬',
		'entrepreneurship': '💼',
		'parenting': '👶',
		'romantic': '❤️',
		'travel': '✈️',
		'inspiration': '💡',
		'technology': '💻',
		'business': '📊',
		'family': '👨‍👩‍👧‍👦',
		'other': '💬'
	};
	return emojiMap[category] || '💬';
}

export default class OmiConversationsPlugin extends Plugin {
	settings: OmiConversationsSettings;
	api: OmiAPI;
	tasksHubSync: TasksHubSync;
	private tasksHubSyncInterval: number | null = null;

	async onload() {
		await this.loadSettings();
		this.api = new OmiAPI(this.settings.apiKey);
		this.tasksHubSync = new TasksHubSync(this);

		// Register the Omi Tasks view
		this.registerView(
			VIEW_TYPE_OMI_TASKS,
			(leaf) => new OmiTasksView(leaf, this)
		);

		// Add settings tab
		this.addSettingTab(new OmiConversationsSettingTab(this.app, this));

		// Add ribbon icon for syncing conversations
		this.addRibbonIcon('brain', 'Sync Omi conversations', async () => {
			await this.syncConversations();
		});

		// Add ribbon icon for opening Omi Tasks view
		this.addRibbonIcon('check-circle', 'Open Omi Tasks', async () => {
			new Notice('Syncing Omi Tasks...');
			await this.activateTasksView();
			// The view will load tasks and show completion notice
		});

		// Add command for syncing conversations
		this.addCommand({
			id: 'sync-conversations',
			name: 'Sync conversations',
			callback: async () => {
				await this.syncConversations();
			}
		});

		// Add command for syncing Tasks Hub
		this.addCommand({
			id: 'sync-tasks-hub',
			name: 'Sync Tasks Hub',
			callback: async () => {
				if (this.settings.enableTasksHub) {
					new Notice('Syncing Tasks Hub...');
					await this.tasksHubSync.pullFromAPI();
					new Notice('Tasks Hub synced');
				} else {
					new Notice('Tasks Hub is not enabled. Enable it in settings.');
				}
			}
		});

		// Add command for opening Omi Tasks view
		this.addCommand({
			id: 'open-omi-tasks-view',
			name: 'Open Omi Tasks',
			callback: () => {
				this.activateTasksView();
			}
		});

		// Initialize Tasks Hub if enabled
		if (this.settings.enableTasksHub) {
			await this.initializeTasksHub();
		}
	}

	async activateTasksView(): Promise<void> {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_OMI_TASKS)[0];
		const wasAlreadyOpen = !!leaf;

		if (!leaf) {
			// Open in main content area as a new tab (not sidebar)
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({ type: VIEW_TYPE_OMI_TASKS, active: true });
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
			// If view was already open, trigger a refresh
			if (wasAlreadyOpen) {
				const view = leaf.view as OmiTasksView;
				await view.loadTasks(true);
				view.render();
			}
		}
	}

	async initializeTasksHub() {
		// Initial pull from API (writes backup file)
		await this.tasksHubSync.pullFromAPI();

		// Set up periodic sync for backup
		this.startTasksHubPeriodicSync();
	}

	startTasksHubPeriodicSync() {
		// Clear existing interval if any
		this.stopTasksHubPeriodicSync();

		if (this.settings.enableTasksHub && this.settings.tasksHubSyncInterval > 0) {
			const intervalMs = this.settings.tasksHubSyncInterval * 60 * 1000;
			this.tasksHubSyncInterval = window.setInterval(() => {
				this.tasksHubSync.pullFromAPI();
			}, intervalMs);
		}
	}

	stopTasksHubPeriodicSync() {
		if (this.tasksHubSyncInterval !== null) {
			window.clearInterval(this.tasksHubSyncInterval);
			this.tasksHubSyncInterval = null;
		}
	}

	onunload() {
		this.stopTasksHubPeriodicSync();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.api) {
			this.api.updateCredentials(this.settings.apiKey);
		}
	}

	async syncConversations() {
		if (!this.settings.apiKey) {
			new Notice('Please set your Omi API key in settings');
			return;
		}

		try {
			// Ensure the folder exists
			const folderPath = normalizePath(this.settings.folderPath);
			await this.ensureFolderExists(folderPath);

			new Notice('Starting Omi conversation sync...');

			// Fetch all conversations starting from the specified date
			const startDate = this.settings.startDate;
			const allConversations = await this.api.getAllConversations(startDate);

			if (!allConversations || allConversations.length === 0) {
				new Notice('No conversations found');
				return;
			}

			// Group conversations by date (using local timezone)
			const conversationsByDate = new Map<string, Conversation[]>();
			for (const conversation of allConversations) {
				// Convert UTC timestamp to local date
				const localDate = new Date(conversation.created_at);
				const year = localDate.getFullYear();
				const month = String(localDate.getMonth() + 1).padStart(2, '0');
				const day = String(localDate.getDate()).padStart(2, '0');
				const dateStr = `${year}-${month}-${day}`;

				if (!conversationsByDate.has(dateStr)) {
					conversationsByDate.set(dateStr, []);
				}
				conversationsByDate.get(dateStr)!.push(conversation);
			}

			// Write folder structure for each date
			for (const [dateStr, conversations] of conversationsByDate) {
				const dateFolderPath = `${folderPath}/${dateStr}`;
				await this.ensureFolderExists(dateFolderPath);

				// Create index file with links
				await this.createIndexFile(dateFolderPath, dateStr, conversations);

				// Create separate files for each section (if enabled)
				if (this.settings.includeOverview) {
					await this.createOverviewFile(dateFolderPath, conversations);
				}
				if (this.settings.includeActionItems) {
					await this.createActionItemsFile(dateFolderPath, conversations);
				}
				if (this.settings.includeEvents) {
					await this.createEventsFile(dateFolderPath, conversations);
				}
				if (this.settings.includeTranscript) {
					await this.createTranscriptFile(dateFolderPath, conversations);
				}
			}

			new Notice(`Synced ${allConversations.length} conversations across ${conversationsByDate.size} days`);
		} catch (error) {
			console.error('Error syncing conversations:', error);
			new Notice('Error syncing Omi conversations. Check console for details.');
		}
	}

	private async ensureFolderExists(path: string) {
		const folder = this.app.vault.getFolderByPath(path);
		if (!folder) {
			await this.app.vault.createFolder(path);
		}
	}

	// Write file using proper vault methods so Obsidian registers it immediately
	private async writeFile(filePath: string, content: string) {
		const existingFile = this.app.vault.getFileByPath(filePath);
		if (existingFile) {
			await this.app.vault.modify(existingFile, content);
		} else {
			await this.app.vault.create(filePath, content);
		}
	}

	private async createIndexFile(folderPath: string, dateStr: string, conversations: Conversation[]) {
		const content: string[] = [];
		content.push(`# ${dateStr} - Conversations`);
		content.push('');
		content.push(`**Total Conversations:** ${conversations.length}`);
		content.push('');

		// Add links to sections
		content.push('## Sections');
		if (this.settings.includeOverview) {
			content.push('- [[overview|Overview]]');
		}
		if (this.settings.includeActionItems) {
			content.push('- [[action-items|Action Items]]');
		}
		if (this.settings.includeEvents) {
			content.push('- [[events|Events]]');
		}
		if (this.settings.includeTranscript) {
			content.push('- [[transcript|Transcript]]');
		}
		content.push('');

		// List all conversations with links to all sections
		content.push('## Conversations');
		for (const conv of conversations) {
			const emoji = conv.structured?.emoji || getCategoryEmoji(conv.structured?.category || 'other');
			const title = conv.structured?.title || 'Untitled';
			const time = new Date(conv.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
			const headingId = `${time} - ${emoji} ${title}`;

			// Build the links based on what's enabled
			const links: string[] = [];
			if (this.settings.includeOverview) {
				links.push(`[[overview#${headingId}|Overview]]`);
			}
			if (this.settings.includeActionItems) {
				links.push(`[[action-items#${headingId}|Action Items]]`);
			}
			if (this.settings.includeEvents) {
				links.push(`[[events#${headingId}|Events]]`);
			}
			if (this.settings.includeTranscript) {
				links.push(`[[transcript#${headingId}|Transcript]]`);
			}

			const linksStr = links.length > 0 ? ` - ${links.join(' | ')}` : '';
			content.push(`- **${time}** - ${emoji} ${title}${linksStr}`);
		}

		const filePath = `${folderPath}/${dateStr}.md`;
		await this.writeFile(filePath, content.join('\n'));
	}

	private async createOverviewFile(folderPath: string, conversations: Conversation[]) {
		const content: string[] = [];
		// No top-level title - filename already shows "overview"

		for (const conv of conversations) {
			const emoji = conv.structured?.emoji || getCategoryEmoji(conv.structured?.category || 'other');
			const title = conv.structured?.title || 'Untitled';
			const time = new Date(conv.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

			// Add clean heading
			content.push(`#### ${time} - ${emoji} ${title}`);

			// Add transcript link on separate line if enabled
			if (this.settings.includeTranscript) {
				const headingId = `${time} - ${emoji} ${title}`;
				content.push(`*([[transcript#${headingId}|Transcript]])*`);
			}

			if (conv.structured?.overview) {
				content.push(conv.structured.overview);
			} else {
				content.push('*No overview available*');
			}
			content.push('');
		}

		const filePath = `${folderPath}/overview.md`;
		await this.writeFile(filePath, content.join('\n'));
	}

	private async createActionItemsFile(folderPath: string, conversations: Conversation[]) {
		const content: string[] = [];
		// No top-level title - filename already shows "action-items"

		let hasItems = false;
		for (const conv of conversations) {
			if (conv.structured?.action_items && conv.structured.action_items.length > 0) {
				hasItems = true;
				const emoji = conv.structured?.emoji || getCategoryEmoji(conv.structured?.category || 'other');
				const title = conv.structured?.title || 'Untitled';
				const time = new Date(conv.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

				// Create context string (link or plain text)
				let context: string;
				if (this.settings.includeOverview) {
					// Link to overview section (must match heading format: #### HH:MM AM/PM - emoji title)
					const headingId = `${time} - ${emoji} ${title}`;
					context = `([[overview#${headingId}|Source]])`;
				} else {
					// Plain text in parentheses
					context = `(${emoji} ${title} - ${time})`;
				}

				for (const item of conv.structured.action_items) {
					const checkbox = item.completed ? '[x]' : '[ ]';
					content.push(`- ${checkbox} ${item.description} ${context}`);
				}
			}
		}

		if (!hasItems) {
			content.push('*No action items for this day*');
		}

		const filePath = `${folderPath}/action-items.md`;
		await this.writeFile(filePath, content.join('\n'));
	}

	private async createEventsFile(folderPath: string, conversations: Conversation[]) {
		const content: string[] = [];
		// No top-level title - filename already shows "events"

		let hasEvents = false;
		for (const conv of conversations) {
			if (conv.structured?.events && conv.structured.events.length > 0) {
				hasEvents = true;
				const emoji = conv.structured?.emoji || getCategoryEmoji(conv.structured?.category || 'other');
				const title = conv.structured?.title || 'Untitled';
				const time = new Date(conv.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

				// Create context string (link or plain text)
				let context: string;
				if (this.settings.includeOverview) {
					// Link to overview section (must match heading format: #### HH:MM AM/PM - emoji title)
					const headingId = `${time} - ${emoji} ${title}`;
					context = `([[overview#${headingId}|Source]])`;
				} else {
					context = `(${emoji} ${title} - ${time})`;
				}

				for (const event of conv.structured.events) {
					const eventDate = new Date(event.start);
					const dateStr = eventDate.toLocaleString('en-US', {
						month: 'short',
						day: 'numeric',
						year: 'numeric',
						hour: 'numeric',
						minute: '2-digit',
						hour12: true
					});
					content.push(`- **${event.title}** - ${dateStr} (${event.duration} min) ${context}`);
					if (event.description) {
						content.push(`  ${event.description}`);
					}
				}
			}
		}

		if (!hasEvents) {
			content.push('*No events for this day*');
		}

		const filePath = `${folderPath}/events.md`;
		await this.writeFile(filePath, content.join('\n'));
	}

	private async createTranscriptFile(folderPath: string, conversations: Conversation[]) {
		const content: string[] = [];
		// No top-level title - filename already shows "transcript"

		for (const conv of conversations) {
			const emoji = conv.structured?.emoji || getCategoryEmoji(conv.structured?.category || 'other');
			const title = conv.structured?.title || 'Untitled';
			const time = new Date(conv.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

			// Add clean heading
			content.push(`#### ${time} - ${emoji} ${title}`);

			// Add overview link on separate line if enabled
			if (this.settings.includeOverview) {
				const headingId = `${time} - ${emoji} ${title}`;
				content.push(`*([[overview#${headingId}|Overview]])*`);
			}
			content.push('');

			if (conv.transcript_segments && conv.transcript_segments.length > 0) {
				for (const segment of conv.transcript_segments) {
					const speaker = segment.speaker || (segment.speaker_id !== undefined ? `Speaker ${segment.speaker_id}` : 'Unknown');
					const startMin = Math.floor(segment.start / 60);
					const startSec = Math.floor(segment.start % 60);
					const timestamp = `${startMin}:${startSec.toString().padStart(2, '0')}`;
					content.push(`**${speaker}** (${timestamp}): ${segment.text}`);
					content.push('');
				}
			} else {
				content.push('*No transcript available*');
				content.push('');
			}
		}

		const filePath = `${folderPath}/transcript.md`;
		await this.writeFile(filePath, content.join('\n'));
	}

	private getLastSyncedDate(): Date | null {
		const folderPath = normalizePath(this.settings.folderPath);
		try {
			const files = this.app.vault.getFiles()
				.filter(file => file.path.startsWith(folderPath + '/'))
				.filter(file => file.path.endsWith('.md'))
				.map(file => file.basename)
				.filter(basename => /^\d{4}-\d{2}-\d{2}$/.test(basename))
				.map(basename => new Date(basename))
				.sort((a, b) => b.getTime() - a.getTime());

			return files.length > 0 ? files[0] : null;
		} catch {
			return null;
		}
	}

	private formatConversationMarkdown(conversation: Conversation): string {
		const content: string[] = [];

		// Title with emoji
		const emoji = conversation.structured?.emoji || '💬';
		const title = conversation.structured?.title || 'Untitled Conversation';
		content.push(`# ${emoji} ${title}`);
		content.push('');

		// Metadata line
		const category = conversation.structured?.category || 'general';
		const startTime = new Date(conversation.started_at);
		const endTime = new Date(conversation.finished_at);
		const timeStr = `${startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} - ${endTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
		content.push(`**Category:** ${category} | **Time:** ${timeStr}`);
		content.push('');

		// Overview (toggleable)
		if (this.settings.includeOverview && conversation.structured?.overview) {
			content.push('## Overview');
			content.push(conversation.structured.overview);
			content.push('');
		}

		// Action Items (toggleable)
		if (this.settings.includeActionItems && conversation.structured?.action_items && conversation.structured.action_items.length > 0) {
			content.push('## Action Items');
			for (const item of conversation.structured.action_items) {
				const checkbox = item.completed ? '[x]' : '[ ]';
				content.push(`- ${checkbox} ${item.description}`);
			}
			content.push('');
		}

		// Events (toggleable)
		if (this.settings.includeEvents && conversation.structured?.events && conversation.structured.events.length > 0) {
			content.push('## Events');
			for (const event of conversation.structured.events) {
				const eventDate = new Date(event.start);
				const dateStr = eventDate.toLocaleString('en-US', {
					month: 'short',
					day: 'numeric',
					year: 'numeric',
					hour: 'numeric',
					minute: '2-digit',
					hour12: true
				});
				content.push(`- **${event.title}** - ${dateStr} (${event.duration} min)`);
				if (event.description) {
					content.push(`  ${event.description}`);
				}
			}
			content.push('');
		}

		// Transcript (toggleable)
		if (this.settings.includeTranscript && conversation.transcript_segments && conversation.transcript_segments.length > 0) {
			content.push('## Transcript');
			for (const segment of conversation.transcript_segments) {
				const speaker = segment.speaker || (segment.speaker_id !== undefined ? `Speaker ${segment.speaker_id}` : 'Unknown');
				const startMin = Math.floor(segment.start / 60);
				const startSec = Math.floor(segment.start % 60);
				const timestamp = `${startMin}:${startSec.toString().padStart(2, '0')}`;
				content.push(`**${speaker}** (${timestamp}): ${segment.text}`);
				content.push('');
			}
		}

		return content.join('\n');
	}
}

class OmiConversationsSettingTab extends PluginSettingTab {
	plugin: OmiConversationsPlugin;

	constructor(app: App, plugin: OmiConversationsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		// ============================================
		// INTRO
		// ============================================
		containerEl.createEl('p', {
			text: 'Connect your Omi AI wearable to Obsidian. Sync conversations, manage tasks, and stay organized.',
			cls: 'setting-item-description'
		});

		// ============================================
		// CONNECTION
		// ============================================
		new Setting(containerEl)
			.setName('Connection')
			.setHeading();

		new Setting(containerEl)
			.setName('Omi API key')
			.setDesc('In the Omi app: Settings → Developer Settings → API → Create Key')
			.addText(text => text
				.setPlaceholder('omi_dev_xxxxxxxx')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		// ============================================
		// TASKS
		// ============================================
		new Setting(containerEl)
			.setName('Tasks')
			.setHeading();

		containerEl.createEl('p', {
			text: 'View and edit your Omi tasks. Changes you make here sync to Omi instantly.',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Enable Omi Tasks')
			.setDesc('Click the checkmark icon in the ribbon or use "Open Omi Tasks" command')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableTasksHub)
				.onChange(async (value) => {
					this.plugin.settings.enableTasksHub = value;
					await this.plugin.saveSettings();

					if (value) {
						await this.plugin.initializeTasksHub();
						new Notice('Omi Tasks enabled');
					} else {
						this.plugin.stopTasksHubPeriodicSync();
						new Notice('Omi Tasks disabled');
					}
				}));

		new Setting(containerEl)
			.setName('Auto-refresh')
			.setDesc('Pull new tasks from Omi (tasks you create in Omi app appear here)')
			.addDropdown(dropdown => dropdown
				.addOption('5', 'Every 5 minutes')
				.addOption('10', 'Every 10 minutes')
				.addOption('15', 'Every 15 minutes')
				.addOption('30', 'Every 30 minutes')
				.addOption('60', 'Every hour')
				.setValue(this.plugin.settings.tasksViewAutoRefresh.toString())
				.onChange(async (value) => {
					this.plugin.settings.tasksViewAutoRefresh = parseInt(value, 10);
					await this.plugin.saveSettings();
				}));

		// ============================================
		// CONVERSATIONS
		// ============================================
		new Setting(containerEl)
			.setName('Conversations')
			.setHeading();

		containerEl.createEl('p', {
			text: 'Import Omi conversations as markdown files. Click the brain icon and select "Sync Conversations" to import.',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Storage folder')
			.setDesc(createFragment(frag => {
				frag.appendText('Where to save conversations and task backups. ');
				frag.createEl('strong', { text: `Currently: ${this.plugin.settings.folderPath}/` });
			}))
			.addText(text => text
				.setPlaceholder('Omi Conversations')
				.setValue(this.plugin.settings.folderPath)
				.onChange(async (value) => {
					this.plugin.settings.folderPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync from date')
			.setDesc('Only import conversations from this date onwards')
			.addText(text => text
				.setPlaceholder('YYYY-MM-DD')
				.setValue(this.plugin.settings.startDate)
				.onChange(async (value) => {
					this.plugin.settings.startDate = value;
					await this.plugin.saveSettings();
				}));

		// Content toggles
		new Setting(containerEl)
			.setName('Conversation content')
			.setDesc('What to include when syncing conversations')
			.setHeading();

		new Setting(containerEl)
			.setName('AI summaries')
			.setDesc('Overview and key points from each conversation')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeOverview)
				.onChange(async (value) => {
					this.plugin.settings.includeOverview = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Action items')
			.setDesc('Tasks mentioned in conversations (read-only, for reference)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeActionItems)
				.onChange(async (value) => {
					this.plugin.settings.includeActionItems = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Calendar events')
			.setDesc('Events and dates mentioned in conversations')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeEvents)
				.onChange(async (value) => {
					this.plugin.settings.includeEvents = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Full transcripts')
			.setDesc('Complete conversation text with timestamps')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeTranscript)
				.onChange(async (value) => {
					this.plugin.settings.includeTranscript = value;
					await this.plugin.saveSettings();
				}));

		// ============================================
		// ADVANCED
		// ============================================
		new Setting(containerEl)
			.setName('Advanced')
			.setHeading();

		new Setting(containerEl)
			.setName('Tasks backup file')
			.setDesc(createFragment(frag => {
				frag.appendText('Backup file name for tasks. Saved to: ');
				frag.createEl('code', { text: `${this.plugin.settings.folderPath}/${this.plugin.settings.tasksHubFilePath}` });
			}))
			.addText(text => text
				.setPlaceholder('Tasks.md')
				.setValue(this.plugin.settings.tasksHubFilePath)
				.onChange(async (value) => {
					this.plugin.settings.tasksHubFilePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Backup sync interval')
			.setDesc('How often to update the Tasks.md backup file (minutes)')
			.addSlider(slider => slider
				.setLimits(1, 60, 1)
				.setValue(this.plugin.settings.tasksHubSyncInterval)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.tasksHubSyncInterval = value;
					await this.plugin.saveSettings();
					if (this.plugin.settings.enableTasksHub) {
						this.plugin.startTasksHubPeriodicSync();
					}
				}));
	}
}

class OmiAPI {
	private apiKey: string;
	private baseUrl = 'https://api.omi.me';
	private batchSize = 100; // Omi default is 100
	private maxRetries = 5;
	private retryDelay = 1000; // 1 second

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	updateCredentials(apiKey: string) {
		this.apiKey = apiKey;
	}

	async getAllConversations(startDate?: string): Promise<Conversation[]> {
		const allConversations: Conversation[] = [];
		let offset = 0;
		const startDateTime = startDate ? new Date(startDate + 'T00:00:00Z').getTime() : 0;

		try {
			// Fetch conversations with pagination using new v1/dev endpoint
			while (true) {
				const params = new URLSearchParams({
					limit: this.batchSize.toString(),
					offset: offset.toString(),
					include_transcript: 'true'
				});

				const conversations = await this.makeRequest(
					`${this.baseUrl}/v1/dev/user/conversations`,
					params
				);

				if (!conversations || conversations.length === 0) break;

				// Filter by start date if provided
				const filteredConversations = startDate
					? conversations.filter((c: Conversation) => new Date(c.created_at).getTime() >= startDateTime)
					: conversations;

				if (filteredConversations.length > 0) {
					allConversations.push(...filteredConversations);
				}

				// If we got less than the batch size, we've reached the end
				if (conversations.length < this.batchSize) break;

				// If all conversations in this batch are older than start date, we can stop
				if (startDate && filteredConversations.length === 0) {
					break;
				}

				offset += this.batchSize;

				// Add a small delay between pagination requests to avoid rate limiting
				await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
			}

			return allConversations;
		} catch (error) {
			console.error('Error fetching conversations:', error);
			throw error;
		}
	}

	private async makeRequest(url: string, params: URLSearchParams): Promise<Conversation[]> {
		let retries = 0;
		while (true) {
			try {
				const response = await requestUrl({
					url: `${url}?${params.toString()}`,
					method: 'GET',
					headers: {
						'Authorization': `Bearer ${this.apiKey}`,
						'Content-Type': 'application/json'
					}
				});

				if (!response.json) {
					throw new Error('Invalid response format');
				}

				return response.json;
			} catch (error) {
				if (error.status === 429 && retries < this.maxRetries) {
					let delay = this.retryDelay * Math.pow(2, retries);
					const retryAfter = error.headers?.['retry-after'];

					if (retryAfter) {
						const retryAfterSeconds = parseInt(retryAfter, 10);
						if (!isNaN(retryAfterSeconds)) {
							delay = retryAfterSeconds * 1000;
						} else {
							const retryAfterDate = new Date(retryAfter);
							const now = new Date();
							delay = retryAfterDate.getTime() - now.getTime();
						}
					}

					new Notice(`Rate limit exceeded. Retrying in ${Math.round(delay / 1000)} seconds...`);
					await new Promise(resolve => setTimeout(resolve, delay));
					retries++;
				} else {
					console.error('Error making request:', error);
					throw error;
				}
			}
		}
	}

	// Action Items API methods (for Tasks Hub)
	async getActionItems(options?: {
		limit?: number;
		offset?: number;
		completed?: boolean;
	}): Promise<ActionItemFromAPI[]> {
		const params = new URLSearchParams();
		if (options?.limit) params.set('limit', options.limit.toString());
		if (options?.offset) params.set('offset', options.offset.toString());
		if (options?.completed !== undefined) params.set('completed', options.completed.toString());

		const url = `${this.baseUrl}/v1/dev/user/action-items`;
		return this.makeApiRequest<ActionItemFromAPI[]>(url, 'GET', params);
	}

	async getAllActionItems(): Promise<ActionItemFromAPI[]> {
		const allItems: ActionItemFromAPI[] = [];
		let offset = 0;
		const limit = 100;

		while (true) {
			const items = await this.getActionItems({ limit, offset });
			if (!items || items.length === 0) break;
			allItems.push(...items);
			if (items.length < limit) break;
			offset += limit;
			await new Promise(resolve => setTimeout(resolve, 300));
		}

		return allItems;
	}

	async createActionItem(description: string, dueAt?: string): Promise<ActionItemFromAPI> {
		const url = `${this.baseUrl}/v1/dev/user/action-items`;
		const body: { description: string; due_at?: string } = { description };
		if (dueAt) body.due_at = dueAt;
		return this.makeApiRequest<ActionItemFromAPI>(url, 'POST', undefined, body);
	}

	async updateActionItem(id: string, updates: {
		description?: string;
		completed?: boolean;
		due_at?: string | null;
	}): Promise<ActionItemFromAPI> {
		const url = `${this.baseUrl}/v1/dev/user/action-items/${id}`;
		return this.makeApiRequest<ActionItemFromAPI>(url, 'PATCH', undefined, updates);
	}

	async deleteActionItem(id: string): Promise<void> {
		const url = `${this.baseUrl}/v1/dev/user/action-items/${id}`;
		await this.makeApiRequest<{ success: boolean }>(url, 'DELETE');
	}

	private async makeApiRequest<T>(
		url: string,
		method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
		params?: URLSearchParams,
		body?: object
	): Promise<T> {
		let retries = 0;
		const fullUrl = params ? `${url}?${params.toString()}` : url;

		while (true) {
			try {
				const requestOptions: {
					url: string;
					method: string;
					headers: Record<string, string>;
					body?: string;
				} = {
					url: fullUrl,
					method,
					headers: {
						'Authorization': `Bearer ${this.apiKey}`,
						'Content-Type': 'application/json'
					}
				};

				if (body) {
					requestOptions.body = JSON.stringify(body);
				}

				const response = await requestUrl(requestOptions);
				return response.json as T;
			} catch (error) {
				if (error.status === 429 && retries < this.maxRetries) {
					let delay = this.retryDelay * Math.pow(2, retries);
					const retryAfter = error.headers?.['retry-after'];

					if (retryAfter) {
						const retryAfterSeconds = parseInt(retryAfter, 10);
						if (!isNaN(retryAfterSeconds)) {
							delay = retryAfterSeconds * 1000;
						} else {
							const retryAfterDate = new Date(retryAfter);
							const now = new Date();
							delay = retryAfterDate.getTime() - now.getTime();
						}
					}

					new Notice(`Rate limit exceeded. Retrying in ${Math.round(delay / 1000)} seconds...`);
					await new Promise(resolve => setTimeout(resolve, delay));
					retries++;
				} else {
					console.error(`Error making ${method} request to ${url}:`, error);
					throw error;
				}
			}
		}
	}
}

class TasksHubSync {
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

	async pullFromAPI(): Promise<void> {
		if (!this.plugin.settings.enableTasksHub || !this.plugin.settings.apiKey) {
			return;
		}

		try {
			const items = await this.plugin.api.getAllActionItems();
			await this.writeToFile(items);
		} catch (error) {
			console.error('Tasks Hub: Error pulling from API:', error);
			new Notice('Failed to sync tasks backup from Omi');
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

// Extended ParsedTask with UI state
interface TaskWithUI extends ParsedTask {
	isEditing: boolean;
}

class OmiTasksView extends ItemView {
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

	constructor(leaf: WorkspaceLeaf, plugin: OmiConversationsPlugin) {
		super(leaf);
		this.plugin = plugin;
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
		const card = container.createDiv('omi-kanban-card');
		card.draggable = true;
		card.dataset.taskId = task.id || '';

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
				}
			} else {
				// Date-based: update due date
				const newDueAt = this.getDateForColumn(columnId);
				const utcDate = this.localToUTC(newDueAt);
				await this.plugin.api.updateActionItem(task.id, { due_at: utcDate });
				task.dueAt = newDueAt;
				this.render();
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
				} catch (error) {
					console.error('Error deleting task:', error);
					new Notice('Failed to delete task');
				}
			}
		);
		modal.open();
	}
}

class AddTaskModal extends Modal {
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

class DatePickerModal extends Modal {
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

class EditTaskModal extends Modal {
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
