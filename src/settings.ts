import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type OmiConversationsPlugin from './main';

export class OmiConversationsSettingTab extends PluginSettingTab {
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
			.addText(text => {
				text
					.setPlaceholder('omi_dev_xxxxxxxx')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						// Allow empty value (clearing the key)
						if (value === '') {
							this.plugin.settings.apiKey = value;
							await this.plugin.saveSettings();
							text.inputEl.classList.remove('omi-input-error');
							return;
						}

						// Validate API key format
						if (!value.startsWith('omi_dev_')) {
							new Notice('Invalid API key format. Key must start with "omi_dev_"');
							text.inputEl.classList.add('omi-input-error');
							return;
						}

						// Valid key - save it
						text.inputEl.classList.remove('omi-input-error');
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
			});

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

		new Setting(containerEl)
			.setName('Completion sounds')
			.setDesc('Play a subtle sound when completing tasks')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableTaskSounds)
				.onChange(async (value) => {
					this.plugin.settings.enableTaskSounds = value;
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
				.setPlaceholder('Omi')
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

		new Setting(containerEl)
			.setName('Auto-sync conversations')
			.setDesc('Automatically import new conversations in the background')
			.addDropdown(dropdown => dropdown
				.addOption('0', 'Manual only')
				.addOption('30', 'Every 30 minutes')
				.addOption('60', 'Every hour')
				.addOption('120', 'Every 2 hours')
				.addOption('360', 'Every 6 hours')
				.setValue(this.plugin.settings.conversationAutoSync.toString())
				.onChange(async (value) => {
					this.plugin.settings.conversationAutoSync = parseInt(value, 10);
					await this.plugin.saveSettings();
					this.plugin.setupConversationAutoSync();
				}));

		// Show sync status and reset button
		const syncedCount = Object.keys(this.plugin.settings.syncedConversations).length;
		const syncStatusDesc = this.plugin.settings.lastConversationSyncTimestamp
			? `Last synced: ${new Date(this.plugin.settings.lastConversationSyncTimestamp).toLocaleString()}. ${syncedCount} conversations tracked.`
			: 'No sync history yet. Run a sync to start tracking.';

		new Setting(containerEl)
			.setName('Sync history')
			.setDesc(syncStatusDesc)
			.addButton(button => button
				.setButtonText('Reset')
				.setTooltip('Clear sync history to force a full resync next time')
				.onClick(async () => {
					this.plugin.settings.lastConversationSyncTimestamp = null;
					this.plugin.settings.syncedConversations = {};
					await this.plugin.saveSettings();
					new Notice('Sync history cleared. Next sync will fetch all conversations.');
					// Refresh the settings display
					this.display();
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
		// DAILY NOTES INTEGRATION
		// ============================================
		new Setting(containerEl)
			.setName('Daily Notes')
			.setHeading();

		containerEl.createEl('p', {
			text: 'Automatically add links to Omi conversations in your daily notes.',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Enable daily notes linking')
			.setDesc('Add "Omi" section to daily notes when syncing')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDailyNotesLink)
				.onChange(async (value) => {
					this.plugin.settings.enableDailyNotesLink = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Daily notes folder')
			.setDesc('Path to your daily notes folder (leave empty for vault root)')
			.addText(text => text
				.setPlaceholder('Daily Notes')
				.setValue(this.plugin.settings.dailyNotesFolder)
				.onChange(async (value) => {
					this.plugin.settings.dailyNotesFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Daily notes format')
			.setDesc('Filename format for daily notes (e.g., YYYY-MM-DD)')
			.addText(text => text
				.setPlaceholder('YYYY-MM-DD')
				.setValue(this.plugin.settings.dailyNotesFormat)
				.onChange(async (value) => {
					this.plugin.settings.dailyNotesFormat = value;
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

		new Setting(containerEl)
			.setName('Memories fetch limit')
			.setDesc('Maximum number of memories to retrieve per request')
			.addSlider(slider => slider
				.setLimits(50, 1000, 50)
				.setValue(this.plugin.settings.memoriesFetchLimit)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.memoriesFetchLimit = value;
					await this.plugin.saveSettings();
				}));
	}
}
