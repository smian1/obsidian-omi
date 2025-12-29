import { Plugin, normalizePath, Notice } from 'obsidian';
import { OmiConversationsSettings, Conversation, SyncedConversationMeta } from './types';
import { DEFAULT_SETTINGS, VIEW_TYPE_OMI_HUB } from './constants';
import { getCategoryEmoji } from './utils';
import { OmiAPI } from './api';
import { TasksHubSync } from './services';
import { OmiHubView } from './views';
import { OmiConversationsSettingTab } from './settings';

export default class OmiConversationsPlugin extends Plugin {
	settings: OmiConversationsSettings;
	api: OmiAPI;
	tasksHubSync: TasksHubSync;
	private tasksHubSyncInterval: number | null = null;
	private conversationSyncInterval: number | null = null;

	async onload() {
		await this.loadSettings();
		this.api = new OmiAPI(this.settings.apiKey);
		this.tasksHubSync = new TasksHubSync(this);

		// Register the Omi Hub view
		this.registerView(
			VIEW_TYPE_OMI_HUB,
			(leaf) => new OmiHubView(leaf, this)
		);

		// Add settings tab
		this.addSettingTab(new OmiConversationsSettingTab(this.app, this));

		// Add ribbon icon for opening Omi Hub
		this.addRibbonIcon('brain', 'Open Omi Hub', async () => {
			await this.activateHubView();
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

		// Add command for opening Omi Hub (with backward compatible alias)
		this.addCommand({
			id: 'open-omi-hub',
			name: 'Open Omi Hub',
			callback: () => {
				this.activateHubView();
			}
		});

		// Keep old command for backward compatibility
		this.addCommand({
			id: 'open-omi-tasks-view',
			name: 'Open Omi Tasks (Legacy)',
			callback: () => {
				this.activateHubView();
			}
		});

		// Initialize Tasks Hub if enabled
		if (this.settings.enableTasksHub) {
			await this.initializeTasksHub();
		}

		// Set up conversation auto-sync if enabled
		this.setupConversationAutoSync();
	}

	async activateHubView(): Promise<void> {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_OMI_HUB)[0];
		const wasAlreadyOpen = !!leaf;

		if (!leaf) {
			// Open in main content area as a new tab (not sidebar)
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({ type: VIEW_TYPE_OMI_HUB, active: true });
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
			// If view was already open and on tasks tab, trigger a refresh
			if (wasAlreadyOpen) {
				const view = leaf.view as OmiHubView;
				if (view.activeTab === 'tasks') {
					await view.loadTasks(true);
					view.render();
				}
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

	setupConversationAutoSync() {
		// Clear existing interval if any
		if (this.conversationSyncInterval !== null) {
			window.clearInterval(this.conversationSyncInterval);
			this.conversationSyncInterval = null;
		}

		// Set up new interval if enabled
		if (this.settings.conversationAutoSync > 0) {
			const intervalMs = this.settings.conversationAutoSync * 60 * 1000;
			this.conversationSyncInterval = window.setInterval(() => {
				this.syncConversations();
			}, intervalMs);
		}
	}

	onunload() {
		this.stopTasksHubPeriodicSync();
		if (this.conversationSyncInterval !== null) {
			window.clearInterval(this.conversationSyncInterval);
		}
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

	async syncConversations(fullResync = false) {
		if (!this.settings.apiKey) {
			new Notice('Please set your Omi API key in settings');
			return;
		}

		try {
			// If full resync, clear tracking data
			if (fullResync) {
				this.settings.lastConversationSyncTimestamp = null;
				this.settings.syncedConversationIds = [];
				await this.saveSettings();
			}

			// Ensure the folder exists
			const folderPath = normalizePath(this.settings.folderPath);
			await this.ensureFolderExists(folderPath);

			new Notice(fullResync ? 'Starting full Omi conversation sync...' : 'Syncing new Omi conversations...');

			// Fetch conversations - use last sync date for incremental, or start date for full
			const startDate = this.settings.startDate;
			const allConversations = await this.api.getAllConversations(startDate);

			if (!allConversations || allConversations.length === 0) {
				new Notice('No conversations found');
				return;
			}

			// Filter to only new conversations (skip already synced)
			const newConversations = fullResync
				? allConversations
				: allConversations.filter(conv => !this.settings.syncedConversationIds.includes(conv.id));

			if (newConversations.length === 0) {
				new Notice('No new conversations to sync');
				return;
			}

			// Group conversations by date (using local timezone)
			const conversationsByDate = new Map<string, Conversation[]>();
			for (const conversation of newConversations) {
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

			// For incremental sync, we need to merge with existing conversations for each date
			for (const [dateStr, conversations] of conversationsByDate) {
				const dateFolderPath = `${folderPath}/${dateStr}`;
				await this.ensureFolderExists(dateFolderPath);

				// For incremental sync, load existing conversations from the date folder
				// and merge with new ones to create complete files
				let allDateConversations = conversations;
				if (!fullResync) {
					const existingConversations = allConversations.filter(conv => {
						const convDate = new Date(conv.created_at);
						const convYear = convDate.getFullYear();
						const convMonth = String(convDate.getMonth() + 1).padStart(2, '0');
						const convDay = String(convDate.getDate()).padStart(2, '0');
						return `${convYear}-${convMonth}-${convDay}` === dateStr;
					});
					allDateConversations = existingConversations;
				}

				// Create index file with links
				await this.createIndexFile(dateFolderPath, dateStr, allDateConversations);

				// Create separate files for each section (if enabled)
				if (this.settings.includeOverview) {
					await this.createOverviewFile(dateFolderPath, allDateConversations);
				}
				if (this.settings.includeActionItems) {
					await this.createActionItemsFile(dateFolderPath, allDateConversations);
				}
				if (this.settings.includeEvents) {
					await this.createEventsFile(dateFolderPath, allDateConversations);
				}
				if (this.settings.includeTranscript) {
					await this.createTranscriptFile(dateFolderPath, allDateConversations);
				}
			}

			// Update tracking after successful sync
			const newIds = newConversations.map(c => c.id);
			this.settings.syncedConversationIds = [
				...this.settings.syncedConversationIds,
				...newIds
			];
			this.settings.lastConversationSyncTimestamp = new Date().toISOString();

			// Store conversation metadata for Hub display
			if (fullResync) {
				this.settings.syncedConversations = {};
			}
			for (const conv of newConversations) {
				const localDate = new Date(conv.created_at);
				const year = localDate.getFullYear();
				const month = String(localDate.getMonth() + 1).padStart(2, '0');
				const day = String(localDate.getDate()).padStart(2, '0');
				const dateStr = `${year}-${month}-${day}`;
				const time = localDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

				// Calculate duration in minutes
				const startTime = new Date(conv.started_at);
				const endTime = new Date(conv.finished_at);
				const durationMs = endTime.getTime() - startTime.getTime();
				const durationMinutes = Math.max(1, Math.round(durationMs / 60000)); // At least 1 min

				// Get overview snippet (first 150 chars)
				const overviewSnippet = conv.structured?.overview
					? conv.structured.overview.substring(0, 150)
					: undefined;

				const meta: SyncedConversationMeta = {
					id: conv.id,
					date: dateStr,
					title: conv.structured?.title || 'Untitled',
					emoji: conv.structured?.emoji || getCategoryEmoji(conv.structured?.category || 'other'),
					time: time,
					category: conv.structured?.category,
					// Timeline & duration data
					startedAt: conv.started_at,
					finishedAt: conv.finished_at,
					duration: durationMinutes,
					// Stats data
					overview: overviewSnippet,
					actionItemCount: conv.structured?.action_items?.length || 0,
					eventCount: conv.structured?.events?.length || 0
				};
				this.settings.syncedConversations[conv.id] = meta;
			}

			await this.saveSettings();

			const syncType = fullResync ? '' : 'new ';
			new Notice(`Synced ${newConversations.length} ${syncType}conversations across ${conversationsByDate.size} days`);
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

			// Add clean heading with conversation ID for reliable matching
			content.push(`#### ${time} - ${emoji} ${title}`);
			content.push(`<!-- conv_id: ${conv.id} -->`);

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

			// Add clean heading with conversation ID for reliable matching
			content.push(`#### ${time} - ${emoji} ${title}`);
			content.push(`<!-- conv_id: ${conv.id} -->`);

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
