import { App } from 'obsidian';

// Settings Interface
export interface OmiConversationsSettings {
	apiKey: string;
	folderPath: string;
	startDate: string;
	includeOverview: boolean;
	includeActionItems: boolean;
	includeEvents: boolean;
	includeTranscript: boolean;
	conversationAutoSync: number;  // Auto-sync interval for conversations (minutes, 0 = disabled)
	// Tasks Hub settings
	enableTasksHub: boolean;
	tasksHubFilePath: string;
	tasksHubSyncInterval: number;
	tasksViewAutoRefresh: number;  // Auto-refresh interval for tasks view (minutes, 0 = disabled)
	// Tasks View preferences (persisted)
	tasksViewMode: 'list' | 'kanban' | 'calendar';
	tasksKanbanLayout: 'status' | 'date';
	tasksCalendarType: 'monthly' | 'weekly';
	// Incremental conversation sync tracking
	lastConversationSyncTimestamp: string | null;
	syncedConversationIds: string[];
	// Hub view settings
	activeHubTab: 'tasks' | 'conversations';
	syncedConversations: Record<string, SyncedConversationMeta>;
	// Conversations view settings
	conversationsViewMode: 'list' | 'timeline' | 'stats' | 'heatmap';
	conversationsTimeRange: 'daily' | 'weekly';
}

// Omi API response types
export interface ActionItem {
	description: string;
	completed: boolean;
}

export interface CalendarEvent {
	title: string;
	start: string;
	duration: number;
	description?: string;
}

export interface TranscriptSegment {
	speaker?: string;
	speaker_id?: number;
	start: number;
	text: string;
}

export interface StructuredData {
	title?: string;
	emoji?: string;
	category?: string;
	overview?: string;
	action_items?: ActionItem[];
	events?: CalendarEvent[];
}

export interface Conversation {
	id: string;
	created_at: string;
	started_at: string;
	finished_at: string;
	structured?: StructuredData;
	transcript_segments?: TranscriptSegment[];
}

// Action Item API types (for Tasks Hub)
export interface ActionItemFromAPI {
	id: string;
	description: string;
	completed: boolean;
	created_at: string;
	updated_at: string;
	due_at: string | null;
	completed_at: string | null;
	conversation_id: string | null;
}

export interface ParsedTask {
	completed: boolean;
	description: string;
	dueAt: string | null;
	sourceLink: string | null;
	id: string | null;
	lineIndex: number;
}

// Extended ParsedTask with UI state
export interface TaskWithUI extends ParsedTask {
	isEditing: boolean;
}

// Synced conversation metadata for Hub view
export interface SyncedConversationMeta {
	id: string;
	date: string;        // YYYY-MM-DD
	title: string;
	emoji: string;
	time: string;        // HH:MM AM/PM
	category?: string;
	// Timeline & duration data
	startedAt: string;      // ISO timestamp for precise timeline positioning
	finishedAt: string;     // ISO timestamp for duration end
	duration: number;       // Minutes (pre-calculated for easy display)
	// Stats data
	overview?: string;      // First 150 chars of AI summary (for cards)
	actionItemCount: number;
	eventCount: number;
}

// Conversation detail data for split pane view
export interface ConversationDetailData {
	overview: string;
	actionItems: ActionItem[];
	events: CalendarEvent[];
	transcript: TranscriptSegment[];
}
