import { OmiConversationsSettings } from './types';

export const VIEW_TYPE_OMI_HUB = 'omi-hub-view';
// Keep old constant as alias for backward compatibility
export const VIEW_TYPE_OMI_TASKS = VIEW_TYPE_OMI_HUB;

// Memory category emoji mapping
export const MEMORY_CATEGORY_EMOJI: Record<string, string> = {
	work: '💼',
	system: '🧠',
	skills: '🎯',
	interests: '💡',
	interesting: '⭐',
	lifestyle: '🏠',
	hobbies: '🎮',
	habits: '🔄',
	core: '💎',
	other: '📌',
	manual: '✏️'
};

export const DEFAULT_SETTINGS: OmiConversationsSettings = {
	apiKey: '',
	folderPath: 'Omi Conversations',
	startDate: '2025-02-09',
	includeOverview: true,
	includeActionItems: true,
	includeEvents: true,
	includeTranscript: true,
	conversationAutoSync: 0,  // Disabled by default (0 = manual only)
	// Tasks Hub defaults
	enableTasksHub: false,
	tasksHubFilePath: 'Tasks.md',  // Relative to folderPath
	tasksHubSyncInterval: 5,
	tasksViewAutoRefresh: 10,  // Auto-refresh every 10 minutes by default
	// Tasks View preferences defaults
	tasksViewMode: 'dashboard',
	tasksCalendarType: 'monthly',
	// Incremental conversation sync tracking defaults
	lastConversationSyncTimestamp: null,
	// Hub view settings
	activeHubTab: 'tasks',
	syncedConversations: {},
	// Memories view settings
	memoriesCategoryFilter: null,
	memoriesViewAutoRefresh: 10,  // Auto-refresh every 10 minutes by default
	memoriesViewMode: 'list',  // Default to list view
	memoriesHubFilePath: 'Memories.md',  // Backup file name
	// Daily notes integration
	enableDailyNotesLink: false,  // Disabled by default
	dailyNotesFolder: '',  // Empty = root of vault
	dailyNotesFormat: 'YYYY-MM-DD',  // Default format
	// Gamification settings
	taskCompletionStreak: 0,
	lastTaskCompletionDate: null,
	enableTaskSounds: false,  // Disabled by default
	// Sync dashboard
	syncHistory: [],
	lastTasksSyncTimestamp: null,
	lastMemoriesSyncTimestamp: null
};
