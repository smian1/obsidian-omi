import { requestUrl, Notice } from 'obsidian';
import { Conversation, ActionItemFromAPI, MemoryFromAPI } from './types';

export class OmiAPI {
	private apiKey: string;
	private baseUrl = 'https://api.omi.me';
	private batchSize = 100; // Omi default is 100
	private maxRetries = 5;
	private retryDelay = 1000; // 1 second
	private onApiCall?: () => void; // Callback to track API calls for rate limiting

	constructor(apiKey: string, onApiCall?: () => void) {
		this.apiKey = apiKey;
		this.onApiCall = onApiCall;
	}

	updateCredentials(apiKey: string) {
		this.apiKey = apiKey;
	}

	setApiCallTracker(callback: () => void) {
		this.onApiCall = callback;
	}

	async getAllConversations(
		startDate?: string,
		onProgress?: (step: string, progress: number) => void,
		isCancelled?: () => boolean,
		onBatch?: (conversations: Conversation[]) => Promise<void>
	): Promise<Conversation[]> {
		const allConversations: Conversation[] = [];
		let offset = 0;
		let pageNum = 0;

		try {
			// Fetch conversations with pagination using new v1/dev endpoint
			while (true) {
				// Check for cancellation before each API call
				if (isCancelled?.()) {
					throw new Error('Sync cancelled');
				}

				pageNum++;
				onProgress?.(`Fetching page ${pageNum}...`, Math.min(80, pageNum * 8));

				const params = new URLSearchParams({
					limit: this.batchSize.toString(),
					offset: offset.toString(),
					include_transcript: 'true'
				});

				// Use server-side date filtering (API supports start_date param)
				if (startDate) {
					params.set('start_date', startDate);
				}

				const conversations = await this.makeRequest(
					`${this.baseUrl}/v1/dev/user/conversations`,
					params
				);

				if (!conversations || conversations.length === 0) break;

				// Server handles date filtering, just add all returned conversations
				allConversations.push(...conversations);
				onProgress?.(`Found ${allConversations.length} conversations...`, Math.min(85, pageNum * 8 + 5));

				// Write files for this batch immediately if callback provided
				if (onBatch) {
					await onBatch(conversations);
				}

				// If we got less than the batch size, we've reached the end
				if (conversations.length < this.batchSize) break;

				offset += this.batchSize;

				// Add a small delay between pagination requests to avoid rate limiting
				await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
			}

			onProgress?.(`Fetched ${allConversations.length} conversations`, 90);
			return allConversations;
		} catch (error) {
			console.error('Error fetching conversations:', error);
			throw error;
		}
	}

	/**
	 * Optimized incremental sync - fetches only new conversations
	 * API returns newest-first, so we stop when we hit a known conversation
	 * Uses server-side date filtering via start_date param for efficiency
	 */
	async getConversationsSince(
		syncedIds: Set<string>,
		lastSyncTime: string | null,
		startDate?: string,
		onProgress?: (step: string, progress: number) => void,
		isCancelled?: () => boolean,
		onBatch?: (conversations: Conversation[]) => Promise<void>
	): Promise<{ conversations: Conversation[]; stoppedEarly: boolean; apiCalls: number }> {
		const newConversations: Conversation[] = [];
		let offset = 0;
		let stoppedEarly = false;
		let apiCalls = 0;
		const lastSync = lastSyncTime ? new Date(lastSyncTime).getTime() : 0;

		try {
			while (true) {
				// Check for cancellation before each API call
				if (isCancelled?.()) {
					throw new Error('Sync cancelled');
				}

				onProgress?.(`Fetching page ${apiCalls + 1}...`, apiCalls > 0 ? Math.min(90, apiCalls * 10) : 5);

				const params = new URLSearchParams({
					limit: this.batchSize.toString(),
					offset: offset.toString(),
					include_transcript: 'true'
				});

				// Use server-side date filtering (API supports start_date param)
				if (startDate) {
					params.set('start_date', startDate);
				}

				const batch = await this.makeRequest(
					`${this.baseUrl}/v1/dev/user/conversations`,
					params
				);
				apiCalls++;

				if (!batch || batch.length === 0) break;

				onProgress?.(`Processing ${newConversations.length + batch.length} conversations...`, Math.min(95, apiCalls * 10));

				const batchNewConversations: Conversation[] = [];
				for (const conv of batch) {
					// Server handles date filtering via start_date param
					// We just need to check for known conversations (stop when known)

					// If we've seen this conversation before
					if (syncedIds.has(conv.id)) {
						// Check if it was updated since last sync
						const convFinished = new Date(conv.finished_at || conv.created_at).getTime();
						if (convFinished <= lastSync) {
							// This conversation hasn't changed since our last sync, stop here
							stoppedEarly = true;
							break;
						}
						// Conversation was updated, include it for re-sync
					}
					batchNewConversations.push(conv);
					newConversations.push(conv);
				}

				// Write files for this batch immediately if callback provided
				if (onBatch && batchNewConversations.length > 0) {
					await onBatch(batchNewConversations);
				}

				if (stoppedEarly) break;
				if (batch.length < this.batchSize) break;

				offset += this.batchSize;
				await new Promise(resolve => setTimeout(resolve, 500));
			}

			onProgress?.('Finalizing...', 100);
			return { conversations: newConversations, stoppedEarly, apiCalls };
		} catch (error) {
			console.error('Error fetching conversations incrementally:', error);
			throw error;
		}
	}

	/**
	 * Fetch conversations for a date or date range (YYYY-MM-DD)
	 * Used for "Resync Single Day" or "Resync Date Range" feature
	 *
	 * Uses server-side filtering with start_date + end_date for efficiency:
	 * - start_date is inclusive
	 * - end_date is exclusive
	 * For single day "2025-04-01": start_date=2025-04-01&end_date=2025-04-02
	 * For range "2025-04-01" to "2025-04-05": start_date=2025-04-01&end_date=2025-04-06
	 *
	 * This fetches only the requested date(s) in a few API calls instead of 50+
	 */
	async getConversationsForDateRange(
		startDateStr: string,  // YYYY-MM-DD in user's local timezone
		endDateStr?: string,   // YYYY-MM-DD optional end date (inclusive)
		onProgress?: (step: string, progress: number) => void
	): Promise<Conversation[]> {
		const conversations: Conversation[] = [];
		let offset = 0;
		let apiCalls = 0;

		// Calculate the API end_date (exclusive)
		// If endDateStr is provided, add 1 day to make it inclusive
		// If not provided, it's a single day so add 1 day to startDateStr
		const targetEndDate = endDateStr
			? new Date(endDateStr + 'T00:00:00')
			: new Date(startDateStr + 'T00:00:00');
		const apiEndDate = new Date(targetEndDate);
		apiEndDate.setDate(apiEndDate.getDate() + 1);
		const apiEndDateStr = `${apiEndDate.getFullYear()}-${String(apiEndDate.getMonth() + 1).padStart(2, '0')}-${String(apiEndDate.getDate()).padStart(2, '0')}`;

		// Date label for progress messages
		const dateLabel = endDateStr && endDateStr !== startDateStr
			? `${startDateStr} to ${endDateStr}`
			: startDateStr;

		try {
			while (true) {
				apiCalls++;
				onProgress?.(`Fetching page ${apiCalls} for ${dateLabel}...`, Math.min(80, apiCalls * 15));

				// Use server-side date filtering: start_date (inclusive) to end_date (exclusive)
				const params = new URLSearchParams({
					limit: this.batchSize.toString(),
					offset: offset.toString(),
					include_transcript: 'true',
					start_date: startDateStr,  // Inclusive: include this date
					end_date: apiEndDateStr    // Exclusive: don't include this date
				});

				const batch = await this.makeRequest(
					`${this.baseUrl}/v1/dev/user/conversations`,
					params
				);

				if (!batch || batch.length === 0) break;

				// Server handles filtering, just add all returned conversations
				conversations.push(...batch);
				onProgress?.(`Found ${conversations.length} conversations...`, Math.min(90, apiCalls * 15 + 10));

				// If we got less than the batch size, we've reached the end
				if (batch.length < this.batchSize) break;

				offset += this.batchSize;
				await new Promise(resolve => setTimeout(resolve, 500));
			}

			onProgress?.(`Found ${conversations.length} conversations for ${dateLabel}`, 100);
			return conversations;
		} catch (error) {
			console.error('Error fetching conversations for date range:', error);
			throw error;
		}
	}

	/**
	 * Fetch conversations for a specific local date (YYYY-MM-DD)
	 * Convenience wrapper for getConversationsForDateRange with single date
	 */
	async getConversationsForDate(
		localDateStr: string,
		onProgress?: (step: string, progress: number) => void
	): Promise<Conversation[]> {
		return this.getConversationsForDateRange(localDateStr, undefined, onProgress);
	}

	private async makeRequest(url: string, params: URLSearchParams): Promise<Conversation[]> {
		let retries = 0;
		while (true) {
			try {
				// Track API call for rate limiting monitoring
				this.onApiCall?.();

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

	// Memories API methods
	async getAllMemories(limit: number = 500): Promise<MemoryFromAPI[]> {
		const url = `${this.baseUrl}/v1/dev/user/memories`;
		const params = new URLSearchParams({ limit: limit.toString() });
		return this.makeApiRequest<MemoryFromAPI[]>(url, 'GET', params);
	}

	async createMemory(content: string, category?: string, visibility?: 'public' | 'private', tags?: string[]): Promise<MemoryFromAPI> {
		const url = `${this.baseUrl}/v1/dev/user/memories`;
		const body: { content: string; category?: string; visibility?: string; tags?: string[] } = { content };
		if (category) body.category = category;
		if (visibility) body.visibility = visibility;
		if (tags && tags.length > 0) body.tags = tags;
		return this.makeApiRequest<MemoryFromAPI>(url, 'POST', undefined, body);
	}

	async updateMemory(id: string, updates: {
		content?: string;
		category?: string;
		visibility?: 'public' | 'private';
	}): Promise<MemoryFromAPI> {
		const url = `${this.baseUrl}/v1/dev/user/memories/${id}`;
		return this.makeApiRequest<MemoryFromAPI>(url, 'PATCH', undefined, updates);
	}

	async deleteMemory(id: string): Promise<void> {
		const url = `${this.baseUrl}/v1/dev/user/memories/${id}`;
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
				// Track API call for rate limiting monitoring
				this.onApiCall?.();

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
