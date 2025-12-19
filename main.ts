import { App, Plugin, PluginSettingTab, Setting, normalizePath, Notice, requestUrl } from 'obsidian';

interface OmiConversationsSettings {
	apiKey: string;
	folderPath: string;
	startDate: string;
	includeOverview: boolean;
	includeActionItems: boolean;
	includeEvents: boolean;
	includeTranscript: boolean;
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

const DEFAULT_SETTINGS: OmiConversationsSettings = {
	apiKey: '',
	folderPath: 'Omi Conversations',
	startDate: '2025-02-09',
	includeOverview: true,
	includeActionItems: true,
	includeEvents: true,
	includeTranscript: true
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

	async onload() {
		await this.loadSettings();
		this.api = new OmiAPI(this.settings.apiKey);

		// Add settings tab
		this.addSettingTab(new OmiConversationsSettingTab(this.app, this));

		// Add ribbon icon for syncing
		this.addRibbonIcon('brain', 'Sync Omi Conversations', async () => {
			await this.syncConversations();
		});

		// Add command for syncing
		this.addCommand({
			id: 'sync-omi-conversations',
			name: 'Sync',
			callback: async () => {
				await this.syncConversations();
			}
		});
	}

	onunload() {

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
		await this.app.vault.adapter.write(filePath, content.join('\n'));
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
		await this.app.vault.adapter.write(filePath, content.join('\n'));
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
		await this.app.vault.adapter.write(filePath, content.join('\n'));
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
		await this.app.vault.adapter.write(filePath, content.join('\n'));
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
					const speaker = segment.speaker || 'Unknown';
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
		await this.app.vault.adapter.write(filePath, content.join('\n'));
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
				const speaker = segment.speaker || 'Unknown';
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

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Your Omi Developer API key (starts with omi_dev_)')
			.addText(text => text
				.setPlaceholder('omi_dev_...')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

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
			.setName('Content options')
			.setDesc('Choose which sections to include in synced conversations')
			.setHeading();

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
			.setName('Include action items')
			.setDesc('Include extracted action items and tasks')
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
}
