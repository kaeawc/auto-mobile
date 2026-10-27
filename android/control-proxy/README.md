# AutoMobile CtrlProxy

This accessibility service provides view hierarchy extraction capabilities for automated Android UI
testing with automatic refresh when screen content changes.

## Features

- **Automatic View Hierarchy Capture**: Automatically detects when screen content changes and marks
  hierarchy for refresh
- **On-Demand Extraction**: Extracts fresh hierarchy only when requested after content changes
- **Wrapper Pruning (API 30+)**: Bounds-only wrapper nodes are promoted or dropped before the tree
  is sent. Baseline accessibility actions (select, accessibility focus) and compat span extras do
  not count as content. A node with a resource id, text, content description, test tag, click or
  long-click handler is never dropped. `adb shell setprop debug.automobile.prune_wrappers false`
  turns it off (or `true` turns it on below API 30); restart the service to apply it.
- **Optional Debug Dump**: Writes hierarchy to app-scoped storage accessible via ADB when enabled
- **Broadcast Communication**: Alternative broadcast-based communication
- **Single Command Interface**: Only exposes one operation - get latest view hierarchy

## Usage

### Optional Hierarchy Debug Dump

The dump is off by default. Enable it by creating a marker in the app's files directory.
The service reads its own user's files directory, and `run-as` without `--user` targets user 0,
so pass the foreground user on a device with a work profile or secondary user:

```bash
CTRL_PROXY_USER=$(adb shell am get-current-user | tr -d '\r')
adb shell run-as dev.jasonpearson.automobile.ctrlproxy --user "$CTRL_PROXY_USER" touch files/dump_hierarchy
```

On a single-user device `CTRL_PROXY_USER` is `0`, which matches plain `run-as`. The commands
below reuse it.

Use the WebSocket `request_hierarchy` request or the daemon's `observe` to request a fresh
hierarchy. After delivery completes, read the dump:

```bash
adb shell run-as dev.jasonpearson.automobile.ctrlproxy --user "$CTRL_PROXY_USER" cat files/latest_hierarchy.json
```

Disable further writes by removing the marker (the last dump remains on disk):

```bash
adb shell run-as dev.jasonpearson.automobile.ctrlproxy --user "$CTRL_PROXY_USER" rm files/dump_hierarchy
```

**Debugging commands if the above doesn't work:**

```bash
# Check if the app is installed
adb shell pm list packages | grep dev.jasonpearson.automobile.ctrlproxy

# Check if the accessibility service is running
adb shell settings get secure enabled_accessibility_services

# Check if the file exists in app storage
adb shell run-as dev.jasonpearson.automobile.ctrlproxy --user "$CTRL_PROXY_USER" ls -la files/

# Check recent logs for both receiver and service
adb logcat -s AccessibilityCommandReceiver CtrlProxy

# Request a hierarchy via WebSocket request_hierarchy or daemon observe, then inspect logs
adb logcat -s CtrlProxy
```

**Benefits:**

- Inspect the latest delivered hierarchy after enabling the marker
- Returns JSON directly to stdout
- No broadcast receivers needed
- Works with any shell scripting
- Uses app-scoped storage (secure and reliable)

### Broadcast Communication (Alternative)

For applications that prefer broadcast-based communication:

```bash
# Request latest view hierarchy
adb shell am broadcast -a dev.jasonpearson.automobile.GET_LATEST_HIERARCHY

# Response will be sent via broadcast:
# Action: dev.jasonpearson.automobile.HIERARCHY_RESPONSE
# Extras: 
#   - json_data (string): JSON-encoded view hierarchy
#   - success (boolean): Whether operation was successful
#   - error (string): Error message if success is false
```

## Response Format

Both interfaces return the same JSON structure:

```json
{
  "packageName": "com.example.app",
  "windowId": 12345,
  "root": {
    "text": "Button Text",
    "contentDescription": "Button Description",
    "className": "android.widget.Button",
    "resourceId": "com.example.app:id/button",
    "bounds": {
      "left": 100,
      "top": 200,
      "right": 300,
      "bottom": 250
    },
    "isClickable": true,
    "isEnabled": true,
    "children": [...]
  }
}
```

For errors (via broadcasts):
```json
{
  "error": "Error message",
  "success": false
}
```

## Integration Examples

### Shell Script
```bash
#!/bin/bash
# Enable the dump, then request a hierarchy via WebSocket request_hierarchy or daemon observe.
CTRL_PROXY_USER=$(adb shell am get-current-user | tr -d '\r')
adb shell run-as dev.jasonpearson.automobile.ctrlproxy --user "$CTRL_PROXY_USER" touch files/dump_hierarchy
# After delivery completes:
HIERARCHY=$(adb shell run-as dev.jasonpearson.automobile.ctrlproxy --user "$CTRL_PROXY_USER" cat files/latest_hierarchy.json)
echo "Current screen hierarchy: $HIERARCHY"
```

### Python Script
```python
import subprocess
import json

def get_view_hierarchy():
    # Enable files/dump_hierarchy first (see above), then request a hierarchy via
    # WebSocket request_hierarchy or daemon observe and wait for delivery before calling.
    # Read the latest debug dump from the foreground user's files directory.
    user = subprocess.run(
        ['adb', 'shell', 'am', 'get-current-user'], capture_output=True, text=True
    ).stdout.strip()
    result = subprocess.run([
        'adb', 'shell', 'run-as', 'dev.jasonpearson.automobile.ctrlproxy', '--user', user,
        'cat', 'files/latest_hierarchy.json'
    ], capture_output=True, text=True)
    
    return json.loads(result.stdout)

hierarchy = get_view_hierarchy()
print(f"Found {len(hierarchy.get('root', {}).get('children', []))} top-level elements")
```

### Broadcast Receiver (Kotlin)
```kotlin
val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        val success = intent?.getBooleanExtra("success", false) ?: false
        val jsonData = intent?.getStringExtra("json_data")
        val error = intent?.getStringExtra("error")
        
        if (success && jsonData != null) {
            // Process JSON view hierarchy
            Log.d("AutoMobile", "View Hierarchy: $jsonData")
        } else {
            Log.e("AutoMobile", "Error: $error")
        }
    }
}

// Register for hierarchy responses
val filter = IntentFilter("dev.jasonpearson.automobile.HIERARCHY_RESPONSE")
context.registerReceiver(receiver, filter)
```

## App Package Information

- **Package Name**: `dev.jasonpearson.automobile.ctrlproxy`
- **Hierarchy File Location**: `files/latest_hierarchy.json` (within app's private directory;
  written only while `files/dump_hierarchy` exists)
- **ADB Access**: Use `run-as dev.jasonpearson.automobile.ctrlproxy --user <current user>` to access
  app-scoped files

## How It Works

1. **Content Change Detection**: Service monitors for window state and content changes
2. **Lazy Extraction**: Hierarchy is only extracted when requested after a content change
3. **Memory Storage**: Latest hierarchy is cached in memory for fast repeated access
4. **File Output**: Changed pushes and `request_hierarchy` replies write to app-scoped storage only
   while the `files/dump_hierarchy` marker exists

## Optimized Architecture

The service uses an optimized approach for minimal overhead:

1. **Event-Driven Refresh**: Only marks hierarchy as needing refresh when content actually changes
2. **Lazy Extraction**: Hierarchy extraction only happens on-demand after content changes
3. **Memory Caching**: Repeated requests return cached data if no content changes occurred
4. **Secure Storage**: Optional debug dumps use app-scoped storage accessible via ADB

This design minimizes CPU usage and battery impact while ensuring fresh data is always available.

## Error Handling

The service includes comprehensive error handling:

- Non-blocking error handling to prevent service crashes
- Error responses in JSON format with detailed messages
- Graceful handling of missing data or service interruptions
- Detailed logging for debugging

## Permissions

The service requires accessibility permissions to be granted manually in device settings:
Settings > Accessibility > AutoMobile CtrlProxy > Enable
