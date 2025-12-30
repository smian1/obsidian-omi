import { Plugin, normalizePath, Notice, Events } from 'obsidian';
import { OmiConversationsSettings, Conversation, SyncedConversationMeta, SyncProgress, SyncHistoryEntry } from './types';
import { DEFAULT_SETTINGS, VIEW_TYPE_OMI_HUB } from './constants';
import { getCategoryEmoji } from './utils';
import { OmiAPI } from './api';
import { TasksHubSync, MemoriesHubSync } from './services';
import { OmiHubView } from './views';
import { OmiConversationsSettingTab } from './settings';

export default class OmiConversationsPlugin extends Plugin {
	settings: OmiConversationsSettings;
	api: OmiAPI;
	tasksHubSync: TasksHubSync;
	memoriesHubSync: MemoriesHubSync;
	private tasksHubSyncInterval: number | null = null;
	private conversationSyncInterval: number | null = null;

	// Sync progress tracking (runtime only, not persisted)
	syncProgress: SyncProgress = {
		isActive: false,
		type: null,
		step: '',
		progress: 0,
		startedAt: 0,
		isCancelled: false
	};

	// Event emitter for sync progress updates
	private syncEvents = new Events();

	// Cancel an ongoing sync
	cancelSync() {
		if (this.syncProgress.isActive) {
			this.syncProgress.isCancelled = true;
			this.syncProgress.step = 'Cancelling...';
			this.syncEvents.trigger('sync-progress');
		}
	}

	async onload() {
		await this.loadSettings();
		this.api = new OmiAPI(this.settings.apiKey);
		this.tasksHubSync = new TasksHubSync(this);
		this.memoriesHubSync = new MemoriesHubSync(this);

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
					const result = await this.tasksHubSync.pullFromAPI();
					this.logSyncHistory({
						type: 'tasks',
						action: 'sync',
						count: result.count,
						error: result.error
					});
					await this.saveSettings();
					new Notice(result.error ? 'Tasks Hub sync failed' : 'Tasks Hub synced');
				} else {
					new Notice('Tasks Hub is not enabled. Enable it in settings.');
				}
			}
		});

		// Add command for syncing Memories Hub
		this.addCommand({
			id: 'sync-memories-hub',
			name: 'Sync Memories Hub',
			callback: async () => {
				new Notice('Syncing Memories Hub...');
				const result = await this.memoriesHubSync.pullFromAPI();
				this.logSyncHistory({
					type: 'memories',
					action: 'sync',
					count: result.count,
					error: result.error
				});
				await this.saveSettings();
				new Notice(result.error ? 'Memories Hub sync failed' : 'Memories Hub synced');
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
				this.syncConversations(false, true); // isAutoSync = true
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

		// Migration: remove deprecated syncedConversationIds if it exists
		const settingsData = this.settings as unknown as Record<string, unknown>;
		if ('syncedConversationIds' in settingsData) {
			delete settingsData.syncedConversationIds;
			await this.saveData(this.settings);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.api) {
			this.api.updateCredentials(this.settings.apiKey);
		}
	}

	// Sync progress event methods
	onSyncProgress(callback: () => void): () => void {
		this.syncEvents.on('sync-progress', callback);
		return () => this.syncEvents.off('sync-progress', callback);
	}

	private updateSyncProgress(type: SyncProgress['type'], step: string, progress: number) {
		this.syncProgress = {
			isActive: type !== null,
			type,
			step,
			progress,
			startedAt: this.syncProgress.startedAt || Date.now(),
			isCancelled: this.syncProgress.isCancelled  // Preserve cancelled state
		};
		this.syncEvents.trigger('sync-progress');
	}

	private clearSyncProgress() {
		this.syncProgress = {
			isActive: false,
			type: null,
			step: '',
			progress: 0,
			startedAt: 0,
			isCancelled: false
		};
		this.syncEvents.trigger('sync-progress');
	}

	// Sync history logging
	private logSyncHistory(entry: Omit<SyncHistoryEntry, 'timestamp'>) {
		const newEntry: SyncHistoryEntry = {
			...entry,
			timestamp: new Date().toISOString()
		};

		// Add to history
		this.settings.syncHistory.unshift(newEntry);

		// Prune entries older than 24 hours and keep max 100
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		this.settings.syncHistory = this.settings.syncHistory
			.filter(e => new Date(e.timestamp).getTime() > cutoff)
			.slice(0, 100);

		// Update type-specific timestamp
		if (entry.type === 'conversations') {
			this.settings.lastConversationSyncTimestamp = newEntry.timestamp;
		} else if (entry.type === 'tasks') {
			this.settings.lastTasksSyncTimestamp = newEntry.timestamp;
		} else if (entry.type === 'memories') {
			this.settings.lastMemoriesSyncTimestamp = newEntry.timestamp;
		}
	}

	async syncConversations(fullResync = false, isAutoSync = false) {
		if (!this.settings.apiKey) {
			new Notice('Please set your Omi API key in settings');
			return;
		}

		// Start progress tracking
		this.updateSyncProgress('conversations', 'Starting...', 0);

		try {
			// If full resync, clear tracking data
			if (fullResync) {
				this.settings.lastConversationSyncTimestamp = null;
				this.settings.syncedConversations = {};
				await this.saveSettings();
			}

			// Ensure the folder exists
			const folderPath = normalizePath(this.settings.folderPath);
			await this.ensureFolderExists(folderPath);

			new Notice(fullResync ? 'Starting full Omi conversation sync...' : 'Syncing new Omi conversations...');

			const startDate = this.settings.startDate;
			const syncedIds = new Set(Object.keys(this.settings.syncedConversations));
			const lastSyncTime = this.settings.lastConversationSyncTimestamp;

			let allConversations: Conversation[] = [];  // Initialize to empty array to avoid undefined error in onBatch callback
			let newConversations: Conversation[];
			let apiCalls = 0;

				// Cancellation check callback
			const isCancelled = () => this.syncProgress.isCancelled;

			// Track written conversations for incremental file writing
			const writtenDates = new Set<string>();

			// Incremental file writing callback - writes files as each batch arrives
			const onBatch = async (batch: Conversation[]) => {
				// Group batch by date
				const batchByDate = new Map<string, Conversation[]>();
				for (const conv of batch) {
					const localDate = new Date(conv.created_at);
					const dateStr = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`;
					if (!batchByDate.has(dateStr)) {
						batchByDate.set(dateStr, []);
					}
					batchByDate.get(dateStr)!.push(conv);
				}

				// Write files for each date in this batch
				for (const [dateStr, convs] of batchByDate) {
					const dateFolderPath = this.getDateFolderPath(folderPath, dateStr);
					await this.ensureFolderExists(dateFolderPath);

					// Get existing conversations for this date to merge
					let allDateConversations = convs;
					if (!fullResync && writtenDates.has(dateStr)) {
						// Already written this date in this sync, skip to avoid duplicates
						continue;
					}

					// Load existing conversations for incremental sync
					if (!fullResync) {
						const existingConvs = Object.values(this.settings.syncedConversations)
							.filter(meta => meta.date === dateStr)
							.map(meta => {
								// Find full conversation data if available
								const existingConv = allConversations.find(c => c.id === meta.id);
								if (existingConv) return existingConv;
								// Reconstruct minimal Conversation from metadata
								return {
									id: meta.id,
									created_at: meta.startedAt,
									started_at: meta.startedAt,
									finished_at: meta.finishedAt,
									structured: {
										title: meta.title,
										emoji: meta.emoji,
										category: meta.category,
										overview: meta.overview || ''
									},
									transcript_segments: [],
									geolocation: meta.geolocation
								} as Conversation;
							});
						allDateConversations = [...convs, ...existingConvs.filter(e => !convs.find(c => c.id === e.id))];
					}

					this.updateSyncProgress('conversations', `Writing ${dateStr}...`, this.syncProgress.progress);

					// Write files
					await this.createIndexFile(dateFolderPath, dateStr, allDateConversations);
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

					writtenDates.add(dateStr);

					// Save metadata for each conversation incrementally
					for (const conv of convs) {
						// Calculate time and duration
						const startTime = new Date(conv.started_at);
						const endTime = new Date(conv.finished_at);
						const durationMs = endTime.getTime() - startTime.getTime();
						const durationMinutes = Math.max(1, Math.round(durationMs / 60000));
						const time = startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

						// Get overview snippet
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
							startedAt: conv.started_at,
							finishedAt: conv.finished_at,
							duration: durationMinutes,
							overview: overviewSnippet,
							actionItemCount: conv.structured?.action_items?.length || 0,
							eventCount: conv.structured?.events?.length || 0,
							geolocation: conv.geolocation || undefined
						};
						this.settings.syncedConversations[conv.id] = meta;
					}
					await this.saveSettings();
				}
			};

			if (fullResync) {
				// Full resync: fetch everything with progress updates and incremental writing
				allConversations = await this.api.getAllConversations(
					startDate,
					(step, progress) => this.updateSyncProgress('conversations', step, progress),
					isCancelled,
					onBatch
				);
				newConversations = allConversations;
				apiCalls = Math.ceil((allConversations.length || 1) / 100);
			} else {
				// Incremental sync: use optimized "stop when known" approach
				// API returns newest-first, so we stop when we hit a known conversation
				const result = await this.api.getConversationsSince(
					syncedIds,
					lastSyncTime,
					startDate,
					(step, progress) => this.updateSyncProgress('conversations', step, progress),
					isCancelled,
					onBatch
				);
				newConversations = result.conversations;
				allConversations = [...newConversations];
				apiCalls = result.apiCalls;
			}

			if (!newConversations || newConversations.length === 0) {
				const apiCallInfo = apiCalls === 1 ? '1 API call' : `${apiCalls} API calls`;
				new Notice(`No new conversations to sync (${apiCallInfo})`);
				this.clearSyncProgress();
				// Log even when no new conversations (shows sync ran)
				this.logSyncHistory({
					type: 'conversations',
					action: isAutoSync ? 'auto-sync' : 'sync',
					count: 0,
					apiCalls
				});
				await this.saveSettings();
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
			// Track dates that need navigation updates
			const newDates: string[] = [];
			const totalDates = conversationsByDate.size;
			let processedDates = 0;

			for (const [dateStr, conversations] of conversationsByDate) {
				processedDates++;
				this.updateSyncProgress(
					'conversations',
					`Writing files for ${dateStr}...`,
					50 + (processedDates / totalDates) * 40
				);

				const dateFolderPath = this.getDateFolderPath(folderPath, dateStr);
				await this.ensureFolderExists(dateFolderPath);
				newDates.push(dateStr);

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

				// Get prev/next dates for navigation
				const allDates = this.getAllSyncedDates();
				// Include dates being synced now
				const allDatesSet = new Set([...allDates, ...Array.from(conversationsByDate.keys())]);
				const sortedAllDates = Array.from(allDatesSet).sort();
				const dateIndex = sortedAllDates.indexOf(dateStr);
				const prevDate = dateIndex > 0 ? sortedAllDates[dateIndex - 1] : null;
				const nextDate = dateIndex < sortedAllDates.length - 1 ? sortedAllDates[dateIndex + 1] : null;

				// Create index file with links and navigation
				await this.createIndexFile(dateFolderPath, dateStr, allDateConversations, prevDate, nextDate);

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

			// Update adjacent days' navigation links (they now have new prev/next)
			if (!fullResync && newDates.length > 0) {
				await this.updateAdjacentDayNavigation(folderPath, newDates, allConversations);
			}

			// Update tracking after successful sync
			this.settings.lastConversationSyncTimestamp = new Date().toISOString();

			// Store conversation metadata for Hub display (also serves as sync tracking)
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
					eventCount: conv.structured?.events?.length || 0,
					// Geolocation data for map view
					geolocation: conv.geolocation || undefined
				};
				this.settings.syncedConversations[conv.id] = meta;
			}

			await this.saveSettings();

			// Also sync memories backup and regenerate master index
			this.updateSyncProgress('conversations', 'Syncing memories...', 92);
			await this.memoriesHubSync.pullFromAPI();
			this.updateSyncProgress('conversations', 'Generating index...', 96);
			await this.generateMasterIndex();

			// Update daily notes with links to Omi conversations
			const syncedDates = Array.from(conversationsByDate.keys());
			await this.updateDailyNotes(syncedDates);

			// Log successful sync
			this.logSyncHistory({
				type: 'conversations',
				action: fullResync ? 'full-resync' : (isAutoSync ? 'auto-sync' : 'sync'),
				count: newConversations.length,
				apiCalls
			});
			await this.saveSettings();

			this.clearSyncProgress();

			const syncType = fullResync ? '' : 'new ';
			const apiCallInfo = apiCalls === 1 ? '1 API call' : `${apiCalls} API calls`;
			new Notice(`Synced ${newConversations.length} ${syncType}conversations across ${conversationsByDate.size} days (${apiCallInfo})`);
		} catch (error) {
			console.error('Error syncing conversations:', error);

			// Log failed sync
			this.logSyncHistory({
				type: 'conversations',
				action: fullResync ? 'full-resync' : (isAutoSync ? 'auto-sync' : 'sync'),
				count: 0,
				error: error instanceof Error ? error.message : 'Unknown error'
			});
			await this.saveSettings();

			this.clearSyncProgress();
			new Notice('Error syncing Omi conversations. Check console for details.');
		}
	}

	/**
	 * Resync conversations for a specific date
	 * Used when Omi device loads historical data and user wants to sync just that day
	 * Handles timezone: filters by LOCAL date (user's timezone)
	 */
	async resyncDay(dateStr: string) {
		if (!this.settings.apiKey) {
			new Notice('Please set your Omi API key in settings');
			return;
		}

		// Validate date format (YYYY-MM-DD)
		if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
			new Notice('Invalid date format. Use YYYY-MM-DD');
			return;
		}

		this.updateSyncProgress('conversations', `Resyncing ${dateStr}...`, 0);

		try {
			const folderPath = normalizePath(this.settings.folderPath);

			// Fetch conversations for just this date
			const conversations = await this.api.getConversationsForDate(
				dateStr,
				(step, progress) => this.updateSyncProgress('conversations', step, progress)
			);

			if (conversations.length === 0) {
				new Notice(`No conversations found for ${dateStr}`);
				this.clearSyncProgress();
				return;
			}

			this.updateSyncProgress('conversations', `Writing files for ${dateStr}...`, 70);

			// Write files for this date
			const dateFolderPath = this.getDateFolderPath(folderPath, dateStr);
			await this.ensureFolderExists(dateFolderPath);

			// Get prev/next dates for navigation
			const allDates = this.getAllSyncedDates();
			const allDatesSet = new Set([...allDates, dateStr]);
			const sortedDates = Array.from(allDatesSet).sort();
			const dateIndex = sortedDates.indexOf(dateStr);
			const prevDate = dateIndex > 0 ? sortedDates[dateIndex - 1] : null;
			const nextDate = dateIndex < sortedDates.length - 1 ? sortedDates[dateIndex + 1] : null;

			// Create files
			await this.createIndexFile(dateFolderPath, dateStr, conversations, prevDate, nextDate);
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

			this.updateSyncProgress('conversations', 'Updating metadata...', 85);

			// Update metadata for these conversations
			for (const conv of conversations) {
				const localDate = new Date(conv.created_at);
				const time = localDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

				// Calculate duration in minutes
				const startTime = new Date(conv.started_at);
				const endTime = new Date(conv.finished_at);
				const durationMs = endTime.getTime() - startTime.getTime();
				const durationMinutes = Math.max(1, Math.round(durationMs / 60000));

				// Get overview snippet
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
					startedAt: conv.started_at,
					finishedAt: conv.finished_at,
					duration: durationMinutes,
					overview: overviewSnippet,
					actionItemCount: conv.structured?.action_items?.length || 0,
					eventCount: conv.structured?.events?.length || 0,
					geolocation: conv.geolocation || undefined
				};
				this.settings.syncedConversations[conv.id] = meta;
			}

			// Update navigation for adjacent days
			this.updateSyncProgress('conversations', 'Updating navigation...', 90);
			await this.updateAdjacentDayNavigation(folderPath, [dateStr], conversations);

			// Regenerate master index
			this.updateSyncProgress('conversations', 'Updating index...', 95);
			await this.generateMasterIndex();

			await this.saveSettings();

			// Log to sync history
			this.logSyncHistory({
				type: 'conversations',
				action: 'sync',
				count: conversations.length,
				apiCalls: 1
			});

			this.clearSyncProgress();
			new Notice(`Resynced ${conversations.length} conversations for ${dateStr}`);

		} catch (error) {
			console.error('Error resyncing day:', error);

			// Log failed sync
			this.logSyncHistory({
				type: 'conversations',
				action: 'sync',
				count: 0,
				error: error instanceof Error ? error.message : 'Unknown error'
			});
			await this.saveSettings();

			this.clearSyncProgress();
			new Notice(`Failed to resync ${dateStr}. Check console for details.`);
		}
	}

	private async ensureFolderExists(path: string) {
		// Handle nested folder creation by creating each level
		const parts = path.split('/').filter(p => p.length > 0);
		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const folder = this.app.vault.getFolderByPath(currentPath);
			if (!folder) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	// Convert YYYY-MM-DD to YYYY/MM/DD folder path
	private getDateFolderPath(basePath: string, dateStr: string): string {
		const [year, month, day] = dateStr.split('-');
		return `${basePath}/${year}/${month}/${day}`;
	}

	// Format a string as an Obsidian tag with omi/ prefix
	private formatOmiTag(value: string): string {
		// Convert to lowercase, replace spaces with hyphens, remove special chars
		return 'omi/' + value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-\/]/g, '');
	}

	// Generate YAML frontmatter for a day's conversations
	private generateFrontmatter(dateStr: string, conversations: Conversation[]): string {
		// Aggregate stats
		const totalDuration = conversations.reduce((sum, conv) => {
			const start = new Date(conv.started_at).getTime();
			const end = new Date(conv.finished_at).getTime();
			return sum + Math.round((end - start) / 60000);
		}, 0);

		const totalActionItems = conversations.reduce((sum, conv) =>
			sum + (conv.structured?.action_items?.length || 0), 0);

		const totalEvents = conversations.reduce((sum, conv) =>
			sum + (conv.structured?.events?.length || 0), 0);

		// Get primary category (most common)
		const categories = conversations.map(c => c.structured?.category || 'other');
		const categoryCounts = categories.reduce((acc, cat) => {
			acc[cat] = (acc[cat] || 0) + 1;
			return acc;
		}, {} as Record<string, number>);
		const primaryCategory = Object.entries(categoryCounts)
			.sort((a, b) => b[1] - a[1])[0]?.[0] || 'other';

		// Get unique locations
		const locations = conversations
			.filter(c => c.geolocation?.address)
			.map(c => c.geolocation!.address!);
		const uniqueLocations = [...new Set(locations)];
		const primaryLocation = uniqueLocations[0] || null;

		// Build tags array
		const tags: string[] = [];
		// Add category tags
		const uniqueCategories = [...new Set(categories)];
		for (const cat of uniqueCategories) {
			tags.push(this.formatOmiTag(cat));
		}
		// Add location tags (simplified to city level)
		for (const loc of uniqueLocations.slice(0, 3)) {
			const city = this.extractCity(loc);
			if (city) {
				tags.push(this.formatOmiTag(`location/${city}`));
			}
		}

		// Build frontmatter
		const lines: string[] = ['---'];
		lines.push(`date: ${dateStr}`);
		lines.push(`conversations: ${conversations.length}`);
		lines.push(`duration: ${totalDuration}`);
		lines.push(`category: ${primaryCategory}`);
		if (primaryLocation) {
			lines.push(`location: "${primaryLocation}"`);
		}
		lines.push(`action_items: ${totalActionItems}`);
		lines.push(`events: ${totalEvents}`);
		if (tags.length > 0) {
			lines.push('tags:');
			for (const tag of tags) {
				lines.push(`  - ${tag}`);
			}
		}
		lines.push('---');
		lines.push('');

		return lines.join('\n');
	}

	// Extract city from address string
	private extractCity(address: string): string | null {
		const parts = address.split(',').map(p => p.trim());
		// Usually city is second-to-last or third-to-last part
		if (parts.length >= 2) {
			// Return the first meaningful part (usually city name)
			return parts[0].toLowerCase().replace(/\s+/g, '-');
		}
		return null;
	}

	// Get all synced dates sorted chronologically
	private getAllSyncedDates(): string[] {
		const dates = new Set<string>();
		for (const meta of Object.values(this.settings.syncedConversations)) {
			dates.add(meta.date);
		}
		return Array.from(dates).sort();
	}

	// Generate master index file with all conversations grouped
	private async generateMasterIndex(): Promise<void> {
		const folderPath = normalizePath(this.settings.folderPath);
		const conversations = Object.values(this.settings.syncedConversations);

		if (conversations.length === 0) {
			return;
		}

		const content: string[] = [];
		content.push('# Omi Conversations Index');
		content.push('');
		content.push(`> ${conversations.length} conversations | Last updated: ${new Date().toLocaleString()}`);
		content.push('');

		// Quick Stats
		const totalDuration = conversations.reduce((sum, c) => sum + (c.duration || 0), 0);
		const hours = Math.floor(totalDuration / 60);
		const mins = totalDuration % 60;
		const uniqueDates = new Set(conversations.map(c => c.date)).size;

		content.push('## Quick Stats');
		content.push(`- **Total Conversations:** ${conversations.length}`);
		content.push(`- **Time Recorded:** ${hours}h ${mins}m`);
		content.push(`- **Days with Conversations:** ${uniqueDates}`);
		content.push('');

		// By Category
		content.push('## By Category');
		const byCategory = this.groupConversationsByCategory(conversations);
		for (const [category, convs] of Object.entries(byCategory)) {
			const emoji = getCategoryEmoji(category);
			content.push(`### ${emoji} ${this.capitalizeFirst(category)} (${convs.length})`);
			// Show first 10
			for (const conv of convs.slice(0, 10)) {
				const convPath = this.getDateFolderPath(folderPath, conv.date);
				content.push(`- [[${convPath}/${conv.date}|${conv.date}]] - ${conv.emoji} ${conv.title}`);
			}
			if (convs.length > 10) {
				content.push(`- *...and ${convs.length - 10} more*`);
			}
			content.push('');
		}

		// By Location
		const withLocation = conversations.filter(c => c.geolocation?.address);
		if (withLocation.length > 0) {
			content.push('## By Location');
			const byLocation = this.groupConversationsByLocation(withLocation);
			const topLocations = Object.entries(byLocation)
				.sort((a, b) => b[1].length - a[1].length)
				.slice(0, 10);

			for (const [location, convs] of topLocations) {
				content.push(`### 📍 ${location} (${convs.length})`);
				for (const conv of convs.slice(0, 5)) {
					const convPath = this.getDateFolderPath(folderPath, conv.date);
					content.push(`- [[${convPath}/${conv.date}|${conv.date}]] - ${conv.emoji} ${conv.title}`);
				}
				if (convs.length > 5) {
					content.push(`- *...and ${convs.length - 5} more*`);
				}
				content.push('');
			}
		}

		// Timeline (grouped by month)
		content.push('## Timeline');
		const byMonth = this.groupConversationsByMonth(conversations);
		for (const [monthKey, convs] of Object.entries(byMonth)) {
			content.push(`### ${monthKey}`);
			for (const conv of convs) {
				const convPath = this.getDateFolderPath(folderPath, conv.date);
				content.push(`- [[${convPath}/${conv.date}|${conv.date} ${conv.time}]] - ${conv.emoji} ${conv.title}`);
			}
			content.push('');
		}

		const filePath = `${folderPath}/_omi-index.md`;
		await this.writeFile(filePath, content.join('\n'));
	}

	private groupConversationsByCategory(convs: SyncedConversationMeta[]): Record<string, SyncedConversationMeta[]> {
		const groups: Record<string, SyncedConversationMeta[]> = {};
		for (const conv of convs) {
			const cat = conv.category || 'other';
			if (!groups[cat]) groups[cat] = [];
			groups[cat].push(conv);
		}
		// Sort each group by date descending
		for (const cat of Object.keys(groups)) {
			groups[cat].sort((a, b) => b.date.localeCompare(a.date));
		}
		return groups;
	}

	private groupConversationsByLocation(convs: SyncedConversationMeta[]): Record<string, SyncedConversationMeta[]> {
		const groups: Record<string, SyncedConversationMeta[]> = {};
		for (const conv of convs) {
			const address = conv.geolocation?.address;
			if (!address) continue;
			// Simplify address to city level
			const simplified = this.simplifyAddress(address);
			if (!groups[simplified]) groups[simplified] = [];
			groups[simplified].push(conv);
		}
		return groups;
	}

	private simplifyAddress(address: string): string {
		const parts = address.split(',').map(p => p.trim());
		// Take last 2-3 parts for city/state/country
		if (parts.length >= 3) {
			return `${parts[parts.length - 3]}, ${parts[parts.length - 2]}`;
		} else if (parts.length >= 2) {
			return `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`;
		}
		return address;
	}

	private groupConversationsByMonth(convs: SyncedConversationMeta[]): Record<string, SyncedConversationMeta[]> {
		const groups: Record<string, SyncedConversationMeta[]> = {};
		// Sort by date descending first
		const sorted = [...convs].sort((a, b) => b.date.localeCompare(a.date));
		for (const conv of sorted) {
			const [year, month] = conv.date.split('-');
			const monthName = new Date(parseInt(year), parseInt(month) - 1).toLocaleString('default', { month: 'long' });
			const key = `${monthName} ${year}`;
			if (!groups[key]) groups[key] = [];
			groups[key].push(conv);
		}
		return groups;
	}

	private capitalizeFirst(str: string): string {
		return str.charAt(0).toUpperCase() + str.slice(1);
	}

	// Format date string according to daily notes format setting
	private formatDateForDailyNote(dateStr: string): string {
		const [year, month, day] = dateStr.split('-');
		// Simple format replacement - supports common patterns
		return this.settings.dailyNotesFormat
			.replace('YYYY', year)
			.replace('MM', month)
			.replace('DD', day)
			.replace('M', String(parseInt(month)))
			.replace('D', String(parseInt(day)));
	}

	// Update daily notes with links to Omi conversations
	private async updateDailyNotes(dates: string[]): Promise<void> {
		if (!this.settings.enableDailyNotesLink) {
			return;
		}

		for (const dateStr of dates) {
			const dailyNoteFilename = this.formatDateForDailyNote(dateStr);
			const dailyNotePath = this.settings.dailyNotesFolder
				? normalizePath(`${this.settings.dailyNotesFolder}/${dailyNoteFilename}.md`)
				: normalizePath(`${dailyNoteFilename}.md`);

			const existingFile = this.app.vault.getFileByPath(dailyNotePath);
			if (!existingFile) {
				// Daily note doesn't exist for this date - skip
				continue;
			}

			// Read existing content
			const content = await this.app.vault.read(existingFile);

			// Check if Omi section already exists
			const omiSectionMarker = '## Omi Conversations';
			if (content.includes(omiSectionMarker)) {
				// Already has Omi section - update it
				const omiConvPath = this.getDateFolderPath(this.settings.folderPath, dateStr);
				const newSection = `${omiSectionMarker}\nSee [[${omiConvPath}/${dateStr}|today's conversations]]`;

				// Replace existing section (up to next ## or end of file)
				const regex = new RegExp(`${omiSectionMarker}[\\s\\S]*?(?=\\n## |$)`, 'g');
				const updatedContent = content.replace(regex, newSection + '\n');
				await this.app.vault.modify(existingFile, updatedContent);
			} else {
				// Add new Omi section at the end
				const omiConvPath = this.getDateFolderPath(this.settings.folderPath, dateStr);
				const omiSection = `\n\n${omiSectionMarker}\nSee [[${omiConvPath}/${dateStr}|today's conversations]]`;
				await this.app.vault.modify(existingFile, content + omiSection);
			}
		}
	}

	// Update navigation links for days adjacent to newly synced dates
	private async updateAdjacentDayNavigation(folderPath: string, newDates: string[], allConversations: Conversation[]) {
		const allDates = this.getAllSyncedDates();
		const adjacentDatesToUpdate = new Set<string>();

		for (const dateStr of newDates) {
			const idx = allDates.indexOf(dateStr);
			// Previous day needs its "next" link updated
			if (idx > 0) {
				adjacentDatesToUpdate.add(allDates[idx - 1]);
			}
			// Next day needs its "prev" link updated
			if (idx < allDates.length - 1) {
				adjacentDatesToUpdate.add(allDates[idx + 1]);
			}
		}

		// Remove dates that were just synced (they're already updated)
		for (const d of newDates) {
			adjacentDatesToUpdate.delete(d);
		}

		// Update each adjacent day's index file
		for (const dateStr of adjacentDatesToUpdate) {
			const dateFolderPath = this.getDateFolderPath(folderPath, dateStr);

			// Get conversations for this date
			const dateConversations = allConversations.filter(conv => {
				const convDate = new Date(conv.created_at);
				const convYear = convDate.getFullYear();
				const convMonth = String(convDate.getMonth() + 1).padStart(2, '0');
				const convDay = String(convDate.getDate()).padStart(2, '0');
				return `${convYear}-${convMonth}-${convDay}` === dateStr;
			});

			if (dateConversations.length > 0) {
				const idx = allDates.indexOf(dateStr);
				const prevDate = idx > 0 ? allDates[idx - 1] : null;
				const nextDate = idx < allDates.length - 1 ? allDates[idx + 1] : null;

				await this.createIndexFile(dateFolderPath, dateStr, dateConversations, prevDate, nextDate);
			}
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

	private async createIndexFile(folderPath: string, dateStr: string, conversations: Conversation[], prevDate: string | null = null, nextDate: string | null = null) {
		const content: string[] = [];

		// Add YAML frontmatter
		content.push(this.generateFrontmatter(dateStr, conversations));

		// Add prev/next navigation
		if (prevDate || nextDate) {
			const navParts: string[] = [];
			if (prevDate) {
				const prevPath = this.getDateFolderPath(this.settings.folderPath, prevDate);
				navParts.push(`[[${prevPath}/${prevDate}|← ${prevDate}]]`);
			}
			navParts.push(`**${dateStr}**`);
			if (nextDate) {
				const nextPath = this.getDateFolderPath(this.settings.folderPath, nextDate);
				navParts.push(`[[${nextPath}/${nextDate}|${nextDate} →]]`);
			}
			content.push(navParts.join(' | '));
			content.push('');
			content.push('---');
			content.push('');
		}

		content.push(`# ${dateStr} - Conversations`);
		content.push('');
		content.push(`**Total Conversations:** ${conversations.length}`);

		// Add location summary if any conversations have location
		const locationsWithAddress = conversations.filter(c => c.geolocation?.address);
		if (locationsWithAddress.length > 0) {
			const uniqueLocations = [...new Set(locationsWithAddress.map(c => c.geolocation!.address!))];
			content.push(`**Locations:** ${uniqueLocations.join(', ')}`);
		}
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

			// Add location if available
			if (conv.geolocation?.address) {
				content.push(`📍 *${conv.geolocation.address}*`);
			}

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
