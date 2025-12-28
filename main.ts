import { App, Plugin, PluginSettingTab, Setting, normalizePath, Notice, requestUrl, TFile, debounce } from 'obsidian';

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
	tasksHubSyncInterval: 5
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

		// Add settings tab
		this.addSettingTab(new OmiConversationsSettingTab(this.app, this));

		// Add ribbon icon for syncing conversations
		this.addRibbonIcon('brain', 'Sync Omi conversations', async () => {
			await this.syncConversations();
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

		// Initialize Tasks Hub if enabled
		if (this.settings.enableTasksHub) {
			await this.initializeTasksHub();
		}
	}

	async initializeTasksHub() {
		// Register file watcher
		this.tasksHubSync.registerFileWatcher();

		// Initial pull from API
		await this.tasksHubSync.pullFromAPI();

		// Set up periodic sync
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

		// API Key (shared between both features)
		new Setting(containerEl)
			.setName('API key')
			.setDesc('Your Omi developer API key (starts with omi_dev_)')
			.addText(text => text
				.setPlaceholder('omi_dev_...')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		// ============================================
		// SECTION 1: Conversation Sync
		// ============================================
		new Setting(containerEl)
			.setName('Conversation Sync')
			.setDesc('Syncs conversation data from Omi. Tasks here are read-only, extracted from conversations.')
			.setHeading();

		new Setting(containerEl)
			.setName('Folder path')
			.setDesc('Where to store the conversation entries')
			.addText(text => text
				.setPlaceholder('Folder path')
				.setValue(this.plugin.settings.folderPath)
				.onChange(async (value) => {
					this.plugin.settings.folderPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Start date')
			.setDesc('Default start date for initial sync (YYYY-MM-DD)')
			.addText(text => text
				.setPlaceholder('YYYY-MM-DD')
				.setValue(this.plugin.settings.startDate)
				.onChange(async (value) => {
					this.plugin.settings.startDate = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Include overview')
			.setDesc('Include the AI-generated overview/summary')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeOverview)
				.onChange(async (value) => {
					this.plugin.settings.includeOverview = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Include conversation tasks')
			.setDesc('Include tasks extracted from conversations (read-only)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeActionItems)
				.onChange(async (value) => {
					this.plugin.settings.includeActionItems = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Include events')
			.setDesc('Include calendar events extracted from conversation')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeEvents)
				.onChange(async (value) => {
					this.plugin.settings.includeEvents = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Include transcript')
			.setDesc('Include full conversation transcript with timestamps')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeTranscript)
				.onChange(async (value) => {
					this.plugin.settings.includeTranscript = value;
					await this.plugin.saveSettings();
				}));

		// ============================================
		// SECTION 2: Tasks Hub
		// ============================================
		new Setting(containerEl)
			.setName('Tasks Hub')
			.setDesc('Bidirectional sync with Omi tasks. Create, edit, complete, and delete tasks from Obsidian.')
			.setHeading();

		new Setting(containerEl)
			.setName('Enable Tasks Hub')
			.setDesc('Enable bidirectional task sync with Omi')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableTasksHub)
				.onChange(async (value) => {
					this.plugin.settings.enableTasksHub = value;
					await this.plugin.saveSettings();

					if (value) {
						await this.plugin.initializeTasksHub();
						new Notice('Tasks Hub enabled. Syncing...');
					} else {
						this.plugin.stopTasksHubPeriodicSync();
						new Notice('Tasks Hub disabled');
					}
				}));

		new Setting(containerEl)
			.setName('Tasks file name')
			.setDesc('File name for tasks (stored in the Conversation Sync folder)')
			.addText(text => text
				.setPlaceholder('Tasks.md')
				.setValue(this.plugin.settings.tasksHubFilePath)
				.onChange(async (value) => {
					this.plugin.settings.tasksHubFilePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync interval (minutes)')
			.setDesc('How often to auto-pull tasks from Omi (1-60 minutes)')
			.addSlider(slider => slider
				.setLimits(1, 60, 1)
				.setValue(this.plugin.settings.tasksHubSyncInterval)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.tasksHubSyncInterval = value;
					await this.plugin.saveSettings();
					// Restart the periodic sync with new interval
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
	private isWriting = false;
	private cachedItems: Map<string, ActionItemFromAPI> = new Map();
	private debouncedHandleFileChange: (file: TFile) => void;

	constructor(plugin: OmiConversationsPlugin) {
		this.plugin = plugin;
		this.debouncedHandleFileChange = debounce(
			(file: TFile) => this.handleFileChange(file),
			20000,  // 20 seconds - give user time to finish typing new tasks
			true
		);
	}

	// Get full path to tasks file (inside the conversations folder)
	private getTasksFilePath(): string {
		const folderPath = this.plugin.settings.folderPath;
		const fileName = this.plugin.settings.tasksHubFilePath;
		return normalizePath(`${folderPath}/${fileName}`);
	}

	registerFileWatcher(): void {
		this.plugin.registerEvent(
			this.plugin.app.vault.on('modify', (file) => {
				if (file instanceof TFile &&
					file.path === this.getTasksFilePath() &&
					!this.isWriting) {
					this.debouncedHandleFileChange(file);
				}
			})
		);
	}

	private async handleFileChange(file: TFile): Promise<void> {
		if (!this.plugin.settings.enableTasksHub) return;

		try {
			const content = await this.plugin.app.vault.read(file);
			const localTasks = this.parseMarkdownTasks(content);

			// Compare with cached items and sync changes
			await this.syncChangesToAPI(localTasks);
		} catch (error) {
			console.error('Error handling file change:', error);
		}
	}

	parseMarkdownTasks(content: string): ParsedTask[] {
		const tasks: ParsedTask[] = [];
		const lines = content.split('\n');

		// New format: - [x] Description 📅 2025-12-29 %%id:abc123%%
		// Also supports old format for backward compatibility during migration
		const newPattern = /^- \[([ x])\] (.+?)(?:\s*📅\s*(\d{4}-\d{2}-\d{2}))?(?:\s*%%id:([a-zA-Z0-9_-]+)%%)?$/;
		const oldPattern = /^- \[([ x])\] (.+?)(?:\s*\(Due: ([^)]+)\))?(?:\s*→\s*\[\[([^\]]+)\]\])?(?:\s*<!--id:([a-zA-Z0-9_-]+)-->)?$/;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Try new format first
			let match = line.match(newPattern);
			if (match) {
				tasks.push({
					completed: match[1] === 'x',
					description: match[2].trim(),
					dueAt: match[3] || null,  // Already in YYYY-MM-DD format
					sourceLink: null,
					id: match[4] || null,
					lineIndex: i
				});
				continue;
			}

			// Fall back to old format for migration
			match = line.match(oldPattern);
			if (match) {
				tasks.push({
					completed: match[1] === 'x',
					description: match[2].trim(),
					dueAt: match[3] || null,  // "Dec 29, 2025" format - will be parsed by parseDueDate
					sourceLink: match[4] || null,
					id: match[5] || null,
					lineIndex: i
				});
			}
		}

		return tasks;
	}

	generateMarkdown(items: ActionItemFromAPI[]): string {
		const lines: string[] = [];

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

		// Add due date with emoji (cleaner, Tasks plugin compatible)
		if (item.due_at) {
			const datePart = item.due_at.split('T')[0];
			line += ` 📅 ${datePart}`;
		}

		// Use Obsidian-native comment %%...%% (invisible in ALL view modes)
		line += ` %%id:${item.id}%%`;

		return line;
	}

	private async syncChangesToAPI(localTasks: ParsedTask[]): Promise<void> {
		const api = this.plugin.api;

		for (const task of localTasks) {
			if (!task.id) {
				// New task - validate before creating
				const description = task.description.trim();

				// Skip if description is too short (user probably still typing)
				if (description.length < 3) {
					console.log('Skipping task creation - description too short:', description);
					continue;
				}

				// Create in API
				try {
					const dueAt = task.dueAt ? this.parseDueDate(task.dueAt) ?? undefined : undefined;
					const created = await api.createActionItem(description, dueAt);
					console.log('Created new task:', created.id);
					// Update the file with the new ID
					await this.updateTaskIdInFile(task.lineIndex, created.id);
				} catch (error) {
					console.error('Error creating task:', error);
					new Notice('Failed to create task in Omi');
				}
			} else {
				// Existing task - check for changes
				const cached = this.cachedItems.get(task.id);
				if (cached) {
					const updates: { description?: string; completed?: boolean; due_at?: string | null } = {};

					if (task.completed !== cached.completed) {
						updates.completed = task.completed;
					}
					if (task.description !== cached.description) {
						updates.description = task.description;
					}

					const localDueAt = task.dueAt ? this.parseDueDate(task.dueAt) : null;
					const cachedDueAt = cached.due_at ? cached.due_at.split('T')[0] : null;
					if (localDueAt !== cachedDueAt) {
						updates.due_at = localDueAt;
					}

					if (Object.keys(updates).length > 0) {
						try {
							await api.updateActionItem(task.id, updates);
							console.log('Updated task:', task.id, updates);
						} catch (error) {
							console.error('Error updating task:', error);
							new Notice('Failed to update task in Omi');
						}
					}
				}
			}
		}

		// Check for deleted tasks
		const localIds = new Set(localTasks.filter(t => t.id).map(t => t.id));
		for (const [cachedId] of this.cachedItems) {
			if (!localIds.has(cachedId)) {
				try {
					await api.deleteActionItem(cachedId);
					console.log('Deleted task:', cachedId);
				} catch (error) {
					console.error('Error deleting task:', error);
					new Notice('Failed to delete task from Omi');
				}
			}
		}

		// Refresh cache after sync
		await this.pullFromAPI();
	}

	private parseDueDate(dueDateStr: string): string | null {
		// Parse due date strings and return YYYY-MM-DD format
		// Supports:
		// - ISO format: "2025-12-29" (new format, return as-is)
		// - Human format: "Dec 27, 2025" (old format, parse and convert)

		// Check if already in ISO format (YYYY-MM-DD)
		if (/^\d{4}-\d{2}-\d{2}$/.test(dueDateStr)) {
			return dueDateStr;
		}

		try {
			// Try parsing human-readable format like "Dec 27, 2025"
			const date = new Date(dueDateStr);
			if (!isNaN(date.getTime()) && date.getFullYear() > 2000) {
				// Use LOCAL date components to avoid timezone shift
				const year = date.getFullYear();
				const month = String(date.getMonth() + 1).padStart(2, '0');
				const day = String(date.getDate()).padStart(2, '0');
				return `${year}-${month}-${day}`;
			}

			// Fallback: try parsing with current year appended (for "Mon DD" format)
			const currentYear = new Date().getFullYear();
			const dateWithYear = new Date(`${dueDateStr}, ${currentYear}`);
			if (!isNaN(dateWithYear.getTime())) {
				const year = dateWithYear.getFullYear();
				const month = String(dateWithYear.getMonth() + 1).padStart(2, '0');
				const day = String(dateWithYear.getDate()).padStart(2, '0');
				return `${year}-${month}-${day}`;
			}
		} catch {
			// Ignore parse errors
		}
		return null;
	}

	private async updateTaskIdInFile(lineIndex: number, newId: string): Promise<void> {
		const filePath = this.getTasksFilePath();
		const file = this.plugin.app.vault.getFileByPath(filePath);
		if (!file) return;

		this.isWriting = true;
		try {
			const content = await this.plugin.app.vault.read(file);
			const lines = content.split('\n');

			if (lineIndex < lines.length) {
				// Remove any existing ID (both old and new formats) and add the new one
				lines[lineIndex] = lines[lineIndex]
					.replace(/\s*<!--id:[^>]+-->/, '')  // Old format
					.replace(/\s*%%id:[^%]+%%/, '')     // New format
					+ ` %%id:${newId}%%`;
				await this.plugin.app.vault.modify(file, lines.join('\n'));
			}
		} finally {
			// Small delay to prevent immediate re-triggering
			setTimeout(() => { this.isWriting = false; }, 100);
		}
	}

	async pullFromAPI(): Promise<void> {
		console.log('Tasks Hub: pullFromAPI called');
		console.log('Tasks Hub: enableTasksHub =', this.plugin.settings.enableTasksHub);
		console.log('Tasks Hub: apiKey present =', !!this.plugin.settings.apiKey);

		if (!this.plugin.settings.enableTasksHub || !this.plugin.settings.apiKey) {
			console.log('Tasks Hub: Skipping pull - not enabled or no API key');
			return;
		}

		try {
			console.log('Tasks Hub: Fetching action items from API...');
			const items = await this.plugin.api.getAllActionItems();
			console.log('Tasks Hub: Fetched', items.length, 'items');

			// Update cache
			this.cachedItems.clear();
			for (const item of items) {
				this.cachedItems.set(item.id, item);
			}

			// Write to file
			console.log('Tasks Hub: Writing to file:', this.getTasksFilePath());
			await this.writeToFile(items);
			console.log('Tasks Hub: File written successfully');
		} catch (error) {
			console.error('Tasks Hub: Error pulling from API:', error);
			new Notice('Failed to sync tasks from Omi');
		}
	}

	private async writeToFile(items: ActionItemFromAPI[]): Promise<void> {
		const filePath = this.getTasksFilePath();

		this.isWriting = true;
		try {
			const content = this.generateMarkdown(items);
			// Use proper vault methods so Obsidian registers the file immediately
			const existingFile = this.plugin.app.vault.getFileByPath(filePath);
			if (existingFile) {
				await this.plugin.app.vault.modify(existingFile, content);
			} else {
				await this.plugin.app.vault.create(filePath, content);
			}
		} finally {
			setTimeout(() => { this.isWriting = false; }, 100);
		}
	}
}
