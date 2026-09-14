# Super Productivity & Tana Outliner Sync

[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)](https://github.com/punchkicker/SuperProductivity-TanaOutliner-Sync/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Super Productivity](https://img.shields.io/badge/Super%20Productivity-%3E%3D14.0.0-green.svg)](https://super-productivity.com/)

A plugin for [Super Productivity](https://super-productivity.com/) that syncs tasks with [Tana](https://tana.inc/) via Tana's local REST API.

Tasks from Tana are imported into Super Productivity with their scheduled dates, deadlines, and notes. When you mark a task complete in Super Productivity, it is checked off in Tana automatically.

---

## Features

- **Two-way completion sync**: Completing a task in Super Productivity marks it done in Tana.
- **Hierarchical task routing & auto-tagging**: Route tasks nested under specific Tana nodes (no matter how deep) or with specific supertags into designated Super Productivity projects and tags.
- **Due dates and scheduled dates**:
  - Scheduled dates map to Super Productivity planned dates (`dueDay` / `plannedAt`).
  - Due dates map to deadlines (`deadlineDay`).
  - Dates use 12:00 UTC to prevent timezone shifts across days.
- **Configurable date fields**: Map custom Tana fields for due dates and planned dates.
- **Daily note auto-planning**: Tasks created under a daily note (or nested under headers on a daily page) can be automatically scheduled for that day.
- **Manual edit protection**: If you reschedule or change dates in Super Productivity, subsequent syncs will not overwrite your changes unless the date was modified in Tana.
- **Location notes**: Breadcrumb paths (with workspace root, daily notes, year, and week clutter removed) and direct Tana links are added to task notes.
- **Clean titles**: Task IDs are tracked invisibly rather than cluttering task names.
- **Background sync**: Automatically polls on a configurable interval (default: 5 minutes) with a manual sync option.

---

## Installation

1. Download `super-productivity-tana-plugin-v1.1.0.zip` from the [Latest Release](https://github.com/punchkicker/SuperProductivity-TanaOutliner-Sync/releases).
2. In Super Productivity, go to **Settings** > **Plugins** (enable plugins if needed).
3. Click **Import Plugin** and select `super-productivity-tana-plugin-v1.1.0.zip`.
4. Open the **Tana Sync** tab in the sidebar to configure your settings.

---

## Configuration

| Setting | Description | Default |
| :--- | :--- | :--- |
| **Tana Local API URL** | URL of Tana's local REST API server. | `http://127.0.0.1:8262` |
| **Tana API Token** | Your Tana API token from Tana Settings > API Tokens. | *(Required)* |
| **Tana Task Tag IDs** | Comma-separated list of supertag IDs. To find an ID: right-click the tag in Tana > "Copy node link" > paste it and copy the ID after `nodeid=` (e.g. `a1b2c3d4e5f6`). | *(Optional)* |
| **Include Checkboxes** | Import standard checkboxes (`- [ ]`) even if they don't have a task supertag. | Checked |
| **Tana Due Date Property** | Tana field name to use as the Super Productivity deadline. | `Due date` |
| **Tana Planned Date Property** | Custom Tana field name to use for planned dates. If blank, uses the parent or daily note. | *(Blank)* |
| **Auto-Plan from Daily Note** | Automatically sets planned date to the daily note date when a task is created on or under a daily note. | Checked |
| **Default Target Project** | Super Productivity project to import tasks into when no routing rule matches. | Inbox (Default) |
| **Default Auto-Tag** | Super Productivity tag to apply when no routing rule matches. | None |
| **Keep Default Tag** | When checked, tasks matching a custom rule retain the default tag in addition to their rule tag. | Checked |
| **Sync Interval** | Background polling interval in minutes. | `5` |

---

### Task Routing Rules

You can define rules to automatically direct imported tasks into specific projects and tags based on where they reside in Tana or what supertag they have:

- **Under Node / Ancestor**: Matches any ancestor in the task's hierarchy. For example, a rule matching `Barcelona, Spain 2026` will catch every task underneath that node, regardless of nesting depth.
- **Has Supertag**: Matches tasks that have a specific Tana supertag.
- **Task Title Contains**: Matches tasks by keyword in the task title.
- **Rule Order**: Rules are evaluated top-to-bottom. Use the up and down arrow buttons to adjust priority.

---

## Architecture

- **UI (`index.html`)**: Runs inside the sandboxed settings iframe and communicates with the background worker via `postMessage`.
- **Background Worker (`plugin.js`)**: Runs in the host application memory with access to `PluginAPI` methods, hooks (`TASK_COMPLETE`), and local storage.
- **Data handling**: Database objects are mapped to plain JavaScript objects before crossing postMessage boundaries. Deadlines are applied via `updateTask` to handle Super Productivity's `addTask` property whitelist.

---

## Requirements

- Super Productivity v14.0.0 or later.
- Tana desktop app running with local API enabled (default port `8262`).

---

## License

MIT License. See [LICENSE](LICENSE) for details.
