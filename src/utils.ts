// Helper function to get emoji based on category
export function getCategoryEmoji(category: string): string {
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
