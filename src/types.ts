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
	tasksViewMode: 'dashboard' | 'list' | 'kanban' | 'calendar';
	tasksCalendarType: 'monthly' | 'weekly';
	// Incremental conversation sync tracking
	lastConversationSyncTimestamp: string | null;
	// Hub view settings
	activeHubTab: 'tasks' | 'conversations' | 'memories' | 'stats' | 'heatmap' | 'map' | 'sync';
	syncedConversations: Record<string, SyncedConversationMeta>;
	// Memories view settings
	memoriesCategoryFilter: string | null;
	memoriesViewAutoRefresh: number;  // Auto-refresh interval (minutes, 0 = disabled)
	memoriesViewMode: 'list' | 'graph';  // View mode: list or tag graph
	memoriesHubFilePath: string;  // Backup file name (e.g., 'Memories.md')
	memoriesFetchLimit: number;  // Max memories to retrieve per request (default 500)
	// Daily notes integration
	enableDailyNotesLink: boolean;  // Toggle daily notes linking
	dailyNotesFolder: string;  // Path to daily notes folder
	dailyNotesFormat: string;  // Date format for daily note filenames (e.g., "YYYY-MM-DD")
	// Gamification settings
	taskCompletionStreak: number;  // Current streak of days with task completions
	lastTaskCompletionDate: string | null;  // YYYY-MM-DD of last completion
	enableTaskSounds: boolean;  // Optional sound effects
	// Sync dashboard
	syncHistory: SyncHistoryEntry[];  // Last 24 hours of sync activity
	lastTasksSyncTimestamp: string | null;
	lastMemoriesSyncTimestamp: string | null;
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

// Geolocation data from Omi API
export interface Geolocation {
	latitude: number;
	longitude: number;
	address?: string;
	google_place_id?: string;
	location_type?: string;
}

export interface Conversation {
	id: string;
	created_at: string;
	started_at: string;
	finished_at: string;
	structured?: StructuredData;
	transcript_segments?: TranscriptSegment[];
	geolocation?: Geolocation | null;
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
	// Geolocation data for map view
	geolocation?: Geolocation;
}

// Conversation detail data for split pane view
export interface ConversationDetailData {
	overview: string;
	actionItems: ActionItem[];
	events: CalendarEvent[];
	transcript: TranscriptSegment[];
}

// Memory API types (for Memories Hub)
export interface MemoryFromAPI {
	id: string;
	content: string;
	category: string;
	visibility: 'public' | 'private';
	tags: string[];
	created_at: string;
	updated_at: string;
	manually_added: boolean;
	scoring: string;
	reviewed: boolean;
	user_review: unknown | null;
	edited: boolean;
}

// Extended Memory with UI state
export interface MemoryWithUI extends MemoryFromAPI {
	isEditing: boolean;
}

// Stats Dashboard Types
export interface HeatmapCell {
	day: number;        // 0-6 (Sun-Sat)
	hour: number;       // 0-23
	count: number;
	duration: number;   // Minutes
	intensity: number;  // 0-1 normalized
}

export interface CategoryStat {
	category: string;
	count: number;
	duration: number;
	percentage: number;
	trend?: number;     // % change from previous period
}

export interface DurationBucket {
	label: string;
	min: number;
	max: number;
	count: number;
	percentage: number;
}

export interface MemoryStats {
	total: number;
	byCategory: Record<string, number>;
	topTags: { tag: string; count: number }[];
	recentCount: number;  // Last 7 days
}

export interface TaskStats {
	total: number;
	completed: number;
	pending: number;
	overdue: number;
	completionRate: number;
	avgCompletionDays: number | null;
}

export type AchievementCategory = 'conversations' | 'streaks' | 'time' | 'location' | 'memory' | 'task' | 'special';

export interface Achievement {
	id: string;
	icon: string;
	title: string;
	description: string;
	category: AchievementCategory;
	unlocked: boolean;
	progress?: number;    // 0-1 for partial progress
	threshold?: number;   // Target value
	current?: number;     // Current value
}

// Data needed to compute all achievements
export interface AchievementData {
	conversationCount: number;
	streak: number;
	lateNightCount: number;
	earlyMorningCount: number;
	uniqueLocations: number;
	memoryCount: number;
	completedTasksCount: number;
	longestConversationMinutes: number;
	conversationsOver30Min: number;
	conversationsOver60Min: number;
	totalHoursRecorded: number;
	uniqueCategories: number;
	daysSinceFirstConversation: number;
}

export interface StatsData {
	// Time range
	timeRange: 'all' | '30days' | 'month' | 'week';
	startDate: Date;
	endDate: Date;

	// Conversation stats
	conversationCount: number;
	totalDuration: number;
	avgDuration: number;

	// Trends (weekly data for sparklines)
	weeklyConversations: number[];
	weeklyDuration: number[];

	// Period comparison
	prevPeriodConversations: number;
	prevPeriodDuration: number;
	conversationTrend: number;  // % change
	durationTrend: number;      // % change

	// Patterns
	heatmap: HeatmapCell[];
	peakDay: string;
	peakHour: string;
	streak: number;

	// Categories
	categories: CategoryStat[];
	topCategory: string;

	// Duration distribution
	durationBuckets: DurationBucket[];

	// From other data sources
	memoryStats: MemoryStats | null;
	taskStats: TaskStats | null;

	// Location stats
	uniqueLocations: number;
	topLocations: { address: string; count: number }[];
	countries: string[];
	states: string[];
	cities: string[];

	// Achievements
	achievements: Achievement[];

	// Time-based counts for achievements
	lateNightCount: number;    // 10pm-4am
	earlyMorningCount: number; // 5am-8am
}

// Sync Dashboard Types
export interface SyncHistoryEntry {
	timestamp: string;  // ISO timestamp
	type: 'conversations' | 'tasks' | 'memories';
	action: 'sync' | 'full-resync' | 'auto-sync' | 'resync';
	count: number;      // Items synced
	apiCalls?: number;  // For conversations
	error?: string;     // If failed
}

// Live sync state (runtime only, not persisted)
export interface SyncProgress {
	isActive: boolean;
	type: 'conversations' | 'tasks' | 'memories' | null;
	step: string;       // "Fetching page 2 of 10"
	progress: number;   // 0-100
	startedAt: number;  // timestamp
	isCancelled: boolean;  // User requested cancellation
}
