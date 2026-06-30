# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GNOME Shell 46 extension (`twingate-gnome@mhsiddiqui.github.io`) written in GJS (ES modules). It puts a panel button in the top bar that reflects Twingate VPN connection state, toggles the connection, lists authorized resources, and lets the user re-authenticate any of them. There is no build step — the source files are the shipped artifact.

## Common commands

```bash
# Install / reinstall locally (copies sources into ~/.local/share/gnome-shell/extensions/)
./install.sh

# Enable after install
gnome-extensions enable twingate-gnome@mhsiddiqui.github.io

# Reload after editing: GNOME Shell must be restarted.
#   X11:     Alt+F2, type 'r', Enter
#   Wayland: log out and back in (no in-session reload)

# Tail extension logs
journalctl /usr/bin/gnome-shell -f -o cat

# Lint (ESLint 9 flat config; no lint script in package.json)
npx eslint extension.js
```

`package.json` has no `scripts` and there are no tests. `@girs/gjs` and `@girs/gnome-shell` are installed only as type/intellisense sources for editors — they are not bundled.

The release zip (`twingate-gnome@mhsiddiqui.github.io.zip`) is produced by `.github/workflows/zip-to-publish.yml` on GitHub release creation. It bundles `icons/ extension.js metadata.json stylesheet.css LICENSE` — keep that file list in sync with anything you add that needs to ship.

## Architecture

Everything lives in `extension.js`. Two classes:

- `TwingateGnomeExtension extends Extension` — GNOME's lifecycle hooks. `enable()` constructs the indicator and adds it to `Main.panel`; `disable()` must call `_indicator.stop()` before `destroy()` so timeouts, signal handlers, and any in-flight subprocess are released. GNOME 45+ disables extensions on lock screen, so `disable()` runs frequently — leaks here matter.
- `TwingateIndicator extends PanelMenu.Button` (registered via `GObject.registerClass`) — the UI and state machine.

### Connection-state model

State is derived, not stored by Twingate for us. The extension polls `GLib.file_test('/run/twingate/auth.sock', EXISTS)` on a `GLib.timeout_add` loop and flips `_connected` when the socket appears/disappears. There is no D-Bus or systemd API call to query state.

Two poll cadences, defined as module-level constants near the top of `extension.js`:
- `SLOW_POLL_MS` (10s) — steady-state background watch.
- `FAST_POLL_MS` (1s) — armed by `_handleToggle` so the UI catches up quickly after the user starts/stops the service. The `onChange` callback passed into `_addFileWatch` swaps back to slow polling on the *next* state transition.

Whenever you change polling, preserve the invariant that `_pollerTimeoutHandle` holds at most one active timeout — `_addFileWatch` does not check before assigning, so callers must `_removeFileWatch()` first (see `_handleToggle`).

### Menu actions and the CLI surface

The panel menu exposes a curated subset of the `twingate` CLI. Interactive/admin subcommands (`setup`, `config`, `account add`, `kube`, `ssh`) are deliberately excluded — they need a terminal, args, or browser flow and can't work as fire-and-forget clicks.

Two state-changing items, both context-aware (label + action swap on `_connected` in `_setUiState`) and both calling `_armFastPoll()` so the socket-poll catches the result quickly:
- `_handleToggle` — full connect/disconnect: `twingate start`+`desktop-start` / `twingate stop`+`desktop-stop`.
- `_handlePause` — pause/resume that keeps tokens: `twingate disconnect` / `twingate connect`.

These shell out via `GLib.spawn_command_line_async` (fire-and-forget; rely on the poll to confirm). Everything that needs output uses `Gio.Subprocess` instead, via two shared helpers:
- `_runForLines(argv, cb)` — runs a command, hands stdout (or `null` on failure) to `cb`. Every spawned proc is added to `this._procs` and removed on completion so `stop()` can `force_exit` anything still in flight.
- `_spawnArgv(argv)` — fire-and-forget in argv form (no shell quoting), used for actions taking a user-derived name (`exit-node switch`, `account switch`, `auth`).

**Submenu caveat:** `PopupSubMenuMenuItem` submenus do **not expand in a nested shell** (`gnome-shell --nested`) — confirmed via logging: the top menu opened and `_setUiState` ran, but the submenu's `open-state-changed` never emitted. They work fine in a real logged-in session (GNOME's own menus use them everywhere). So anything that must be testable in the nested dev shell uses a modal, while fixed command groups the user accepted verifying in a real session use submenus.

Exit node and Account therefore open **modal dialogs**: flat `PopupMenuItem`s (`_exitNodeItem` gated on `_connected`, `_accountItem` always live) that call `_openCommandDialog(...)`.

Service and Notifications are **submenus** (`_serviceMenu` / `_notifMenu`, built by `_buildCommandSubMenu(title, entries)`) of fixed one-shot commands: Service → `service-start`/`service-stop` (no `service-restart` exists in the CLI); Notifications → `desktop-start`/`desktop-stop`/`desktop-restart`. Each child item's `activate` handle is tracked in `this._subItemHandles` and disconnected in `stop()` (the submenu `destroy()` tears down the child actors).

`_openCommandDialog({title, topActions, listArgv, listHeader, skip, emptyText, onPick, extraButtons, parse})` is the shared modal: optional fixed action rows on top (exit-node start/stop, plain `_rowbtn` action buttons), then a `listArgv`-loaded list of names each running `onPick(name)`, plus optional dialog buttons (account's Logout). The list is rendered as a **single-column table** matching the Resources modal — a `listHeader` row (`_thead`/`_hcell`) over zebra-striped, border-separated rows. **Each row must mirror the Resources row structure exactly** — a `_trow` `St.BoxLayout` wrapping a single `_cell`/`_namebtn` `St.Button` whose label is `x_align: START` + ellipsized — so the data's left edge lines up with the `_hcell` header (both at 8px). Do **not** make the row itself the button (an earlier version did, and the button-vs-boxlayout structural mismatch threw the header out of alignment). It's tracked in `this._cmdDialog` (separate from the resources `this._dialog`), closed when going offline, and destroyed in `stop()`. List parsing defaults to `_parseList(out, skipSubstrings)` (a best-effort splitter dropping blanks, "no …" lines, and leading markers) but callers can pass a custom `parse(out)` returning the cleaned names. **Account uses `parse: _parseAccountEmails`** because `twingate account list` is a 3-column table (`EMAIL <tab> NETWORK <tab> NETWORK URL`) — it drops the header row and returns the email column (a valid `account switch <account-id>` identifier, which accepts email / email:tenant_slug / account ID). `_loadVersion` fills one info line from `twingate version`; `_loadUser` fills the **Current User** line (`_userItem`) from the first email of `account list` via the same `_parseAccountEmails` (loaded once at construction, like the version line); `_handleReport` runs `twingate report` and surfaces the first output line via `Main.notify`. The Resources modal title is "Resources" (no "Twingate" prefix); the command dialogs are titled "Exit node" / "Account".

### Icon rendering

Icon swap is pure CSS class toggling on a single `St.Icon`: `_setUiState` writes `this.icon.style_class` to either `twingate_gnome_local_on` or `twingate_gnome_local_off` (the `ICON_ON`/`ICON_OFF` constants), both defined in `stylesheet.css` with `background-image: url("icons/...")`. Adding new visual states means new classes in `stylesheet.css` plus PNGs under `icons/` (and updating the workflow file list above).

GNOME loads every enabled extension's `stylesheet.css` into one shared `St` theme — selectors are global, not namespaced per extension. The `twingate_gnome_local_*` names are deliberately namespaced so they don't collide with any other Twingate-related extension a user might have installed (some define plain `.twingate_on` / `.twingate_off`). If you rename these, keep both the constants in `extension.js` and the selectors in `stylesheet.css` in sync, and keep them unique.

### Resources modal

The panel menu has a single `Resources…` item (`_resourcesItem`) that opens a `ModalDialog` (`resource:///org/gnome/shell/ui/modalDialog.js`) — chosen over an inline `PopupSubMenuMenuItem` because the submenu was cramped and hid each resource's address. The dialog holds a title bar (`_dialogTitleBar`: heading + top-right ✕ close button), a search `St.Entry`, and a scrollable `St.ScrollView` → `St.BoxLayout` containing a **table**: a header row (`twingate_gnome_local_thead`, styled distinct) plus one data row per resource (`twingate_gnome_local_trow`, zebra-striped via `_trow_alt` on odd rows, `border-bottom` separators). Columns are Name / Address / Alias / Auth. Alignment works because header and data cells share fixed-width column classes (`_c_name` / `_c_alias` / `_c_auth`); the Address column has no fixed width and `x_expand`s to fill the rest — so all four cells must keep matching classes/expand flags between `_headerCell` and `_valueCell` or the columns drift. **Critical:** in St, CSS `width` is only a *preferred* width — a wrapping label reports a large minimum width (longest word/URL) that forces its cell wider than the column, drifting everything to its right. So the fixed-width columns (Name button label, Alias, Auth) must `ellipsize` (`Pango.EllipsizeMode.END`, line-wrap off) — that drops the label's min width to ~0 so the CSS `width` is actually honored. Only the expanding Address column keeps `set_line_wrap(true)`, since it has flexible width to absorb. If you add a fixed column, ellipsize its label or it will misalign with long data. The Name cell is an `St.Button` (runs `twingate auth <name>`); Address and Alias cells (`_valueCell` with copyable=true) carry a copy button that writes the value to the clipboard via `St.Clipboard` and briefly swaps its icon to a checkmark (`_copyText` / `_resetCopyIcon`, a tracked single-shot timeout cleaned up on re-render, dialog close, and `stop()`). Typing filters (`_renderResourceList` re-renders against name/address/alias); Enter authenticates the first match. The `name/address/alias/auth` column mapping is an assumption from `_parseResources` — the header row makes a mismatch obvious; fix the parse if the CLI columns differ. The scroll area's `height` is **not** in CSS — it's set in JS via `_dialogScrollHeight()` (`min(600, monitor.height − 320)`, floor 160) on both this dialog and the command dialog, so the whole modal fits the screen and the dialog's action buttons (Refresh/Close) stay visible instead of overflowing off the bottom. Only `min-width` stays in the `_scroll` CSS class.

Data flow: `_loadResources(force, onComplete)` runs `twingate -d resources` via `Gio.Subprocess` (STDOUT_PIPE) and `_parseResources` turns the tab-separated output into `this._resources`. Loading is lazy — prefetched when the panel menu opens (so the dialog is instant) and re-run on demand by the dialog's Refresh button. `_renderResourceList` reads `_resourcesLoading` / `_resourcesError` / `_resources` to show Loading / Failed / list / empty states, so it's safe to call before, during, and after a load. The header row is detected by the `RESOURCE NAME` literal — if Twingate ever changes the column header the parse will treat the header as a row, so keep that check in sync with the CLI output.

Lifecycle: the dialog is created lazily with `destroyOnClose: true`; its `destroy` handler nulls `_dialog`/`_searchEntry`/`_listBox` so stale references never leak. `_setUiState` closes the dialog and clears the cache when going offline, and `setSensitive` greys out `Resources…` while disconnected. `stop()` destroys any open dialog. CSS classes are namespaced `twingate_gnome_local_*` for the same global-theme reason as the icon classes.

### Things to know when modifying

- `metadata.json` `shell-version` is `["46"]` only — bump deliberately after testing.
- GObject type names must stay unique per process — all GNOME extensions share one shell process. `TwingateIndicator` is registered with an explicit `GTypeName: 'TwingateGnomeLocalIndicator'` precisely so it can coexist with other Twingate-related extensions (a plain class name like `TwingateIndicator` would collide with another extension using the same name, and whichever loads second fails with `Type name … is already registered`). Keep this `GTypeName` unique and namespaced; do not drop it.
- ESLint config uses `globals.browser`, which is wrong for GJS (no `window`/`document`). If you tighten lint rules, switch to a GJS-appropriate global set or the extension globals will trip false positives.
- ESLint default config flags `_e` catch parameters as unused. The codebase uses bare `catch {}` (ES2019) for ignored errors — keep that style or configure `argsIgnorePattern: "^_"`.
