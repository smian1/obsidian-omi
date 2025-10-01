# Omi Conversations for Obsidian

Sync your Omi AI conversation memories directly into organized Obsidian markdown files.

## Features

- 📥 **Automatic Sync** - Download your Omi conversations with a single click
- 📁 **Smart Organization** - Each day gets its own folder with separate files for:
  - Overview summaries
  - Action items
  - Calendar events
  - Full transcripts
- 🔗 **Cross-Linked Navigation** - Jump between related sections easily
- ⚙️ **Flexible Content** - Toggle which sections to sync (overview, action items, events, transcript)
- 🕐 **Local Timezone** - All timestamps shown in your local time
- 🔄 **Incremental Sync** - Only fetches conversations from your specified start date onwards

## Installation

### Manual Installation

1. Download the latest release
2. Extract into your vault's `.obsidian/plugins/obsidian-omi` folder
3. Reload Obsidian
4. Enable "Omi Conversations" in Community Plugins

## Configuration

1. Open Obsidian Settings → Omi Conversations
2. Enter your **Omi Developer API Key** (from Omi developer settings)
3. Set your **Folder Path** (default: "Omi Conversations")
4. Set your **Start Date** (YYYY-MM-DD format)
5. Toggle which **Content Options** you want to sync

### Getting Your Omi API Key

1. Open the Omi app on your device
2. Navigate to **Settings** → **Developer**
3. Under the "Developer API Keys" section, click **"Create Key"**
4. Give your key a descriptive name (e.g., "Obsidian")
5. **Copy the key immediately** - you won't be able to see it again!
6. Paste the key into the plugin settings in Obsidian

That's it! No app creation or additional configuration needed.

## Usage

### Sync Conversations

Click the 🧠 brain icon in the left ribbon, or use the command palette:
- `Ctrl/Cmd + P` → "Omi Conversations: Sync"

### Folder Structure

```
Omi Conversations/
└── 2025-09-30/
    ├── 2025-09-30.md      ← Index with links to all conversations
    ├── overview.md         ← AI-generated summaries
    ├── action-items.md     ← Extracted tasks and action items
    ├── events.md           ← Calendar events from conversations
    └── transcript.md       ← Full conversation transcripts
```

### Navigation

The index file (`2025-09-30.md`) contains:
- Links to each section (Overview, Action Items, Events, Transcript)
- List of all conversations with direct links to each section

Example:
```markdown
## Conversations
- **09:18 PM** - 🔧 User Requests Code Fixes - [[overview#...]] | [[action-items#...]] | [[transcript#...]]
```

### Content Options

Toggle what gets synced in settings:

- **Include Overview** - AI-generated conversation summaries
- **Include Action Items** - Extracted tasks and to-dos (with checkboxes)
- **Include Events** - Calendar events extracted from conversations
- **Include Transcript** - Full conversation transcripts with speaker labels and timestamps

## File Format

### Overview
- H4 headings with timestamp and emoji
- Links to transcript for full details
- AI-generated summary of each conversation

### Action Items
- Flat list format with checkboxes
- Links back to overview for context
- Grouped by conversation source

### Events
- Event title, date/time, and duration
- Links back to overview for context
- Only shows conversations with events

### Transcript
- H4 headings matching overview format
- Speaker labels with timestamps (MM:SS)
- Complete conversation text

## Troubleshooting

### Rate Limiting
If you see rate limit warnings:
- The plugin automatically retries with exponential backoff
- Reduce sync frequency if syncing large date ranges

### Links Not Working
- Ensure you're using the latest version
- Headings must match exactly (including emojis and timestamps)
- Try re-syncing to regenerate files

### No Conversations Appearing
- Verify your API Key is correct (starts with `omi_dev_`)
- Ensure your start date is correct (YYYY-MM-DD format)
- Check that you have conversations in your Omi account

### Timezone Issues
- All timestamps are converted to your computer's local timezone
- Files are organized by local date, not UTC

## API Information

This plugin uses the Omi Developer API:
- Endpoint: `GET /v1/dev/user/conversations`
- Authentication: Developer API key (starts with `omi_dev_`)
- Features: Automatic user identification, pagination, date filtering
- See [docs.omi.me](https://docs.omi.me) for more details

## License

MIT

## Credits
By Salman M.

## Support

For issues or feature requests, please visit the [GitHub repository](https://github.com/smian1/obsidian-omi)