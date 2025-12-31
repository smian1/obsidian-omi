#!/bin/bash

# Package Obsidian plugin for distribution
# Usage: ./scripts/package.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Extract current version from manifest.json
VERSION=$(grep '"version"' manifest.json | sed 's/.*: "\(.*\)".*/\1/')

# Parse version into components and increment patch
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"
NEW_PATCH=$((PATCH + 1))
NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"

echo "Bumping version: $VERSION → $NEW_VERSION"

# Update manifest.json
sed -i '' "s/\"version\": \"$VERSION\"/\"version\": \"$NEW_VERSION\"/" manifest.json

# Update package.json
sed -i '' "s/\"version\": \"$VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json

# Add entry to versions.json (insert after last existing entry)
MIN_APP_VERSION=$(grep '"minAppVersion"' manifest.json | sed 's/.*: "\(.*\)".*/\1/')
sed -i '' "s/\"$VERSION\": \"$MIN_APP_VERSION\"/\"$VERSION\": \"$MIN_APP_VERSION\",\\
	\"$NEW_VERSION\": \"$MIN_APP_VERSION\"/" versions.json

# Use new version for package name
VERSION="$NEW_VERSION"
PLUGIN_ID="omi-conversations"
DIST_DIR="dist"
ZIP_NAME="omi-obsidian-plugin-v${VERSION}.zip"

echo "Packaging $PLUGIN_ID v$VERSION..."

# Build the plugin
echo "Building..."
npm run build

# Clean and create dist folder
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/$PLUGIN_ID"

# Copy required files
echo "Copying files..."
cp manifest.json "$DIST_DIR/$PLUGIN_ID/"
cp main.js "$DIST_DIR/$PLUGIN_ID/"
cp styles.css "$DIST_DIR/$PLUGIN_ID/"

# Create INSTALL.md
cat > "$DIST_DIR/$PLUGIN_ID/INSTALL.md" << 'EOF'
# Installing Omi Conversations Plugin

## Manual Installation

1. Open your Obsidian vault folder in Finder/Explorer
2. Navigate to `.obsidian/plugins/` (create `plugins` folder if it doesn't exist)
3. Create a new folder called `omi-conversations`
4. Copy these files into it:
   - `manifest.json`
   - `main.js`
   - `styles.css`
5. Open Obsidian
6. Go to Settings > Community Plugins
7. Disable "Restricted mode" if prompted
8. Find "Omi Conversations" and enable it
9. Configure your Omi API key in the plugin settings

## Configuration

After enabling, go to the plugin settings and enter your Omi developer API key.
You can get one from your Omi account settings.
EOF

# Create zip
echo "Creating zip..."
cd "$DIST_DIR"
zip -r "$ZIP_NAME" "$PLUGIN_ID"

echo ""
echo "Done! Created: dist/$ZIP_NAME"
echo "Share this zip file with others to install the plugin."
