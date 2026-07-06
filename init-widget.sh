#!/usr/bin/env bash
set -euo pipefail

WIDGET_NAME="${1:-}"
if [ -z "$WIDGET_NAME" ]; then
  echo "Usage: ./init-widget.sh WidgetName"
  echo "  e.g. ./init-widget.sh BarChart"
  exit 1
fi

echo "Initialising widget: $WIDGET_NAME"

# Rename component directories
mv "src/components/WidgetTemplate" "src/components/$WIDGET_NAME"
mv "src/components/WidgetTemplateConfiguration" "src/components/${WIDGET_NAME}Configuration"

# Rename files inside the widget directory
mv "src/components/$WIDGET_NAME/WidgetTemplate.tsx" "src/components/$WIDGET_NAME/$WIDGET_NAME.tsx"
mv "src/components/$WIDGET_NAME/WidgetTemplate.css" "src/components/$WIDGET_NAME/$WIDGET_NAME.css"

# Rename files inside the configurator directory
mv "src/components/${WIDGET_NAME}Configuration/WidgetTemplateConfiguration.tsx" \
   "src/components/${WIDGET_NAME}Configuration/${WIDGET_NAME}Configuration.tsx"
mv "src/components/${WIDGET_NAME}Configuration/WidgetTemplateConfiguration.css" \
   "src/components/${WIDGET_NAME}Configuration/${WIDGET_NAME}Configuration.css"

# Replace all WidgetTemplate occurrences in source files (macOS-compatible sed)
find src -type f \( -name "*.tsx" -o -name "*.ts" -o -name "*.css" \) \
  -exec sed -i '' "s/WidgetTemplate/$WIDGET_NAME/g" {} +

# Update webpack.config.js entries
sed -i '' "s/WidgetTemplate/$WIDGET_NAME/g" webpack.config.js

# Update package.json name (lowercase widget name)
WIDGET_LOWER=$(echo "$WIDGET_NAME" | tr '[:upper:]' '[:lower:]')
sed -i '' "s/iosense-widget-template/iosense-${WIDGET_LOWER}-widget/g" package.json

# Update HTML title
sed -i '' "s/WidgetTemplate Widget/$WIDGET_NAME Widget/g" public/index.html

echo ""
echo "Done. Next steps:"
echo "  npm install"
echo "  npm start"
echo "  # Visit http://localhost:3000/?token=<SSO_TOKEN> to authenticate"
