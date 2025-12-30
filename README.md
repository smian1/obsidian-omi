# Omi Conversations for Obsidian

Sync your [Omi AI](https://omi.me) conversations, tasks, and memories to Obsidian as searchable markdown files with Dataview-compatible metadata.

## Features

- **Conversations Sync** - Download conversations with AI summaries, action items, events, and transcripts
- **Omi Hub** - Interactive dashboard with multiple views (tasks, conversations, memories, stats, map)
- **Tasks Hub** - Bidirectional task sync with list, kanban, and calendar views
- **Memories** - Browse and search your Omi memories with tag graph visualization
- **Stats Dashboard** - Analytics, heatmaps, and achievement tracking
- **Map View** - Geographic visualization of conversations
- **Dataview Integration** - YAML frontmatter for powerful queries
- **Daily Notes** - Automatic linking to your daily notes

## Installation

### Manual Installation

1. Download the latest release
2. Extract into your vault's `.obsidian/plugins/obsidian-omi` folder
3. Reload Obsidian
4. Enable "Omi Conversations" in Community Plugins

## Quick Start

1. Open **Settings > Omi Conversations**
2. Enter your **Omi Developer API Key** (see below)
3. Click the brain icon in the ribbon to open **Omi Hub**
4. Go to the **Sync** tab and click **Full Resync**

### Getting Your Omi API Key

1. Open the Omi app on your device
2. Navigate to **Settings > Developer**
3. Click **"Create Key"** under Developer API Keys
4. Copy the key (starts with `omi_dev_`)
5. Paste into plugin settings

## File Structure

The plugin creates organized markdown files in a nested hierarchy:

```
Omi Conversations/
├── _omi-index.md          # Master index linking all conversations
├── Memories.md            # Searchable backup of all memories
├── Tasks.md               # Backup of all tasks
└── 2025/
    └── 01/
        └── 09/
            ├── 2025-01-09.md    # Daily index with navigation
            ├── overview.md       # AI summaries for each conversation
            ├── action-items.md   # Tasks extracted from conversations
            ├── events.md         # Calendar events mentioned
            └── transcript.md     # Full conversation transcripts
```

### Daily Index Navigation

Each daily index includes prev/next day navigation:

```markdown
[[2025/01/08/2025-01-08|<< 2025-01-08]] | **2025-01-09** | [[2025/01/10/2025-01-10|2025-01-10 >>]]
```

## YAML Frontmatter

Each file includes structured metadata compatible with [Dataview](https://github.com/blacksmithgu/obsidian-dataview):

```yaml
---
date: 2025-01-09
category: work
duration: 45
location: San Francisco, CA
conversations: 3
action_items: 5
events: 2
tags:
  - omi/work
  - omi/location/san-francisco
---
```

### Properties

| Property | Description |
|----------|-------------|
| `date` | Date of the conversation (YYYY-MM-DD) |
| `category` | AI-detected category (work, personal, health, etc.) |
| `duration` | Length in minutes |
| `location` | Address where conversation occurred |
| `conversations` | Number of conversations that day |
| `action_items` | Tasks extracted from conversations |
| `events` | Calendar events mentioned |
| `tags` | Hierarchical tags with `omi/` prefix |

## Tags

All tags use the `#omi/` prefix to avoid conflicts with your existing tags:

- **Categories**: `#omi/work`, `#omi/personal`, `#omi/health`, `#omi/finance`
- **Locations**: `#omi/location/san-francisco`, `#omi/location/new-york`

## Dataview Queries

With the [Dataview plugin](https://github.com/blacksmithgu/obsidian-dataview) installed, you can query your Omi data:

### Basic Queries

#### List work conversations
```dataview
TABLE date, duration, location
FROM "Omi Conversations"
WHERE category = "work"
SORT date DESC
```

#### Conversations by location
```dataview
LIST
FROM #omi/location/san-francisco
SORT date DESC
```

#### Pending action items
```dataview
TASK
FROM "Omi Conversations"
WHERE !completed
LIMIT 20
```

---

### 📊 Analytics & Summaries

#### Weekly conversation summary
```dataview
TABLE
    length(rows) as "Conversations",
    sum(rows.duration) as "Total Min",
    round(sum(rows.duration)/60, 1) as "Hours"
FROM "Omi Conversations"
WHERE date >= date(today) - dur(7 days)
GROUP BY dateformat(date, "ccc, MMM d") as Day
SORT date DESC
```

#### Category breakdown with stats
```dataview
TABLE WITHOUT ID
    category as "Category",
    length(rows) as "Count",
    round(sum(rows.duration)/60, 1) + " hrs" as "Time",
    round(length(rows) / 7 * 100) + "%" as "% of Week"
FROM "Omi Conversations"
WHERE date >= date(today) - dur(7 days)
GROUP BY category
SORT length(rows) DESC
```

#### Monthly totals dashboard
```dataview
TABLE WITHOUT ID
    dateformat(date, "MMMM yyyy") as "Month",
    length(rows) as "Conversations",
    round(sum(rows.duration)/60, 1) + " hours" as "Total Time",
    round(average(rows.duration), 0) + " min" as "Avg Length"
FROM "Omi Conversations"
GROUP BY dateformat(date, "yyyy-MM")
SORT date DESC
LIMIT 6
```

---

### 🔥 Insights & Patterns

#### Long conversations (deep work sessions)
```dataview
TABLE date, category, duration + " min" as "Length", location
FROM "Omi Conversations"
WHERE duration > 30
SORT duration DESC
LIMIT 10
```

#### Most productive locations
```dataview
TABLE WITHOUT ID
    location as "Location",
    length(rows) as "Visits",
    round(sum(rows.duration)/60, 1) + " hrs" as "Time Spent"
FROM "Omi Conversations"
WHERE location != null
GROUP BY location
SORT sum(rows.duration) DESC
LIMIT 5
```

#### Recent activity streak
```dataview
LIST WITHOUT ID
    "📅 " + dateformat(date, "ccc, MMM d") + " — " +
    length(rows) + " conversations (" +
    sum(rows.duration) + " min)"
FROM "Omi Conversations"
WHERE date >= date(today) - dur(14 days)
GROUP BY date
SORT date DESC
```

---

### 🎯 Task & Action Item Queries

#### Action items by conversation
```dataview
TABLE WITHOUT ID
    file.link as "Day",
    action_items as "Tasks",
    category
FROM "Omi Conversations"
WHERE action_items > 0
SORT date DESC
LIMIT 10
```

#### Days with most action items
```dataview
TABLE WITHOUT ID
    dateformat(date, "MMM d, yyyy") as "Date",
    action_items as "Tasks Created",
    category,
    duration + " min" as "Duration"
FROM "Omi Conversations"
WHERE action_items > 3
SORT action_items DESC
```

---

### 🗓️ Time-Based Views

#### Today's conversations
```dataview
LIST
FROM "Omi Conversations"
WHERE date = date(today)
SORT file.ctime DESC
```

#### This week's highlights
```dataview
TABLE WITHOUT ID
    dateformat(date, "ccc") as "Day",
    category,
    duration + " min" as "Duration",
    action_items as "Tasks"
FROM "Omi Conversations"
WHERE date >= date(today) - dur(7 days)
SORT date DESC
```

#### Busiest days of the week
```dataview
TABLE WITHOUT ID
    dateformat(date, "cccc") as "Day of Week",
    length(rows) as "Total Conversations",
    round(average(rows.duration), 0) + " min" as "Avg Duration"
FROM "Omi Conversations"
GROUP BY dateformat(date, "c")
SORT length(rows) DESC
```

---

### 🏷️ Tag-Based Queries

#### All work-related conversations
```dataview
LIST
FROM #omi/work
SORT date DESC
LIMIT 15
```

#### Cross-reference: Work + specific location
```dataview
TABLE date, duration, location
FROM #omi/work AND #omi/location/san-francisco
SORT date DESC
```

#### Browse by any category
```dataview
TABLE WITHOUT ID
    category as "Category",
    length(rows) as "Count",
    min(rows.date) as "First",
    max(rows.date) as "Latest"
FROM "Omi Conversations"
GROUP BY category
SORT length(rows) DESC
```

---

### 🔗 Daily Notes Integration

#### Embed today's Omi summary in your daily note
```dataview
TABLE WITHOUT ID
    file.link as "Conversation",
    duration + " min" as "Duration",
    action_items as "Tasks"
FROM "Omi Conversations"
WHERE date = this.file.day
```

#### Link recent conversations from daily note
```dataview
LIST
FROM "Omi Conversations"
WHERE date >= this.file.day - dur(3 days) AND date <= this.file.day
SORT date DESC
```

## Omi Hub

Click the brain icon to open Omi Hub, a unified dashboard with multiple tabs:

### Tasks Tab
- **Dashboard** - Overview with pending tasks and streaks
- **List** - Collapsible sections by due date
- **Kanban** - Drag-and-drop columns
- **Calendar** - Monthly/weekly grid view

### Conversations Tab
- **List** - Card view of synced conversations
- **Timeline** - Daily/weekly timeline visualization
- **Detail** - Split pane with summary and transcript

### Memories Tab
- **List** - Browse memories by category
- **Graph** - Tag relationship visualization

### Stats Tab
- Analytics with time range filtering
- Category breakdown
- Duration distribution
- Achievements and streaks

### Heatmap Tab
- Activity calendar showing conversation frequency

### Map Tab
- Geographic view using conversation geolocation data

### Sync Tab
- Live sync progress with cancel button
- Status cards for conversations, tasks, memories
- Auto-sync toggles and interval settings
- Sync history log (last 24 hours)

## Daily Notes Integration

Automatically add links to Omi conversations in your daily notes:

1. Go to **Settings > Omi Conversations > Daily Notes**
2. Enable **"Daily notes linking"**
3. Set your daily notes folder and filename format

After syncing, your daily note will include:

```markdown
## Omi Conversations
See [[Omi Conversations/2025/01/09/2025-01-09|today's conversations]]
```

## Commands

| Command | Description |
|---------|-------------|
| `Omi Conversations: Sync conversations` | Fetch new conversations |
| `Omi Conversations: Full resync` | Re-download all conversations |
| `Omi Conversations: Sync Tasks Hub` | Refresh tasks backup file |
| `Omi Conversations: Sync Memories Hub` | Refresh memories backup file |
| `Omi Conversations: Open Omi Hub` | Open the main dashboard |

## Settings

| Setting | Description |
|---------|-------------|
| **API Key** | Your Omi developer API key (`omi_dev_*`) |
| **Folder Path** | Where to store conversation files |
| **Start Date** | Only sync conversations after this date |
| **Auto-sync** | Automatically sync at intervals (0 = disabled) |
| **Include Overview** | Create overview.md with AI summaries |
| **Include Action Items** | Create action-items.md with tasks |
| **Include Events** | Create events.md with calendar events |
| **Include Transcript** | Create transcript.md with full text |
| **Enable Tasks Hub** | Enable tasks backup file |
| **Daily Notes Folder** | Path to daily notes folder |
| **Daily Notes Format** | Filename format (e.g., YYYY-MM-DD) |

## Troubleshooting

### Rate Limiting
- The plugin automatically retries with exponential backoff
- Check the Sync tab for detailed error messages

### Links Not Working
- Ensure headings match exactly (including emojis and timestamps)
- Try re-syncing to regenerate files

### No Conversations Appearing
- Verify your API Key is correct (starts with `omi_dev_`)
- Check your start date (YYYY-MM-DD format)
- Confirm you have conversations in your Omi account

### Timezone Issues
- All timestamps are converted to your computer's local timezone
- Files are organized by local date, not UTC

## API Information

This plugin uses the Omi Developer API:
- Endpoint: `GET /v1/dev/user/conversations`
- Authentication: Developer API key
- Features: Server-side date filtering, pagination, incremental sync
- See [docs.omi.me](https://docs.omi.me) for details

## License

MIT

## Credits

By Salman M.

## Support

For issues or feature requests, visit [GitHub](https://github.com/smian1/obsidian-omi)
