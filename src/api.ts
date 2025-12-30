import { requestUrl, Notice } from 'obsidian';
import { Conversation, ActionItemFromAPI, MemoryFromAPI } from './types';

export class OmiAPI {
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

	/**
	 * Optimized incremental sync - fetches only new conversations
	 * API returns newest-first, so we stop when we hit a known conversation
	 */
	async getConversationsSince(
		syncedIds: Set<string>,
		lastSyncTime: string | null,
		startDate?: string,
		onProgress?: (step: string, progress: number) => void
	): Promise<{ conversations: Conversation[]; stoppedEarly: boolean; apiCalls: number }> {
		const newConversations: Conversation[] = [];
		let offset = 0;
		let stoppedEarly = false;
		let apiCalls = 0;
		const lastSync = lastSyncTime ? new Date(lastSyncTime).getTime() : 0;
		const startDateTime = startDate ? new Date(startDate + 'T00:00:00Z').getTime() : 0;

		try {
			while (true) {
				onProgress?.(`Fetching page ${apiCalls + 1}...`, apiCalls > 0 ? Math.min(90, apiCalls * 10) : 5);

				const params = new URLSearchParams({
					limit: this.batchSize.toString(),
					offset: offset.toString(),
					include_transcript: 'true'
				});

				const batch = await this.makeRequest(
					`${this.baseUrl}/v1/dev/user/conversations`,
					params
				);
				apiCalls++;

				if (!batch || batch.length === 0) break;

				onProgress?.(`Processing ${newConversations.length + batch.length} conversations...`, Math.min(95, apiCalls * 10));

				for (const conv of batch) {
					// Filter by start date if provided
					if (startDate && new Date(conv.created_at).getTime() < startDateTime) {
						// Reached conversations older than start date, stop
						stoppedEarly = true;
						break;
					}

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
					newConversations.push(conv);
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

	// Memories API methods
	async getAllMemories(): Promise<MemoryFromAPI[]> {
		const url = `${this.baseUrl}/v1/dev/user/memories`;
		const params = new URLSearchParams({ limit: '500' });
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
