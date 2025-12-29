import { OmiConversationsSettings } from './types';

export const VIEW_TYPE_OMI_HUB = 'omi-hub-view';
// Keep old constant as alias for backward compatibility
export const VIEW_TYPE_OMI_TASKS = VIEW_TYPE_OMI_HUB;

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
	tasksViewMode: 'list',
	tasksKanbanLayout: 'status',
	tasksCalendarType: 'monthly',
	// Incremental conversation sync tracking defaults
	lastConversationSyncTimestamp: null,
	syncedConversationIds: [],
	// Hub view settings
	activeHubTab: 'tasks',
	syncedConversations: {},
	// Conversations view settings
	conversationsViewMode: 'list',
	conversationsTimeRange: 'daily'
};
