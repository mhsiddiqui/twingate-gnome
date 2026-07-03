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
npx eslint extension.js subprocess.js
```

`package.json` has no `scripts` and there are no tests. `@girs/gjs` and `@girs/gnome-shell` are installed only as type/intellisense sources for editors — they are not bundled.

The release zip (`twingate-gnome@mhsiddiqui.github.io.zip`) is produced by `.github/workflows/zip-to-publish.yml` on GitHub release creation. It bundles `extension.js subprocess.js metadata.json stylesheet.css LICENSE` — keep that file list in sync (and `install.sh`'s `cp` line) with anything you add that needs to ship. There is **no `icons/` folder** — the panel icon uses stock Adwaita symbolic icons (see Icon rendering), per EGO's "don't ship unnecessary files" guideline.

## Architecture

Two source files: `extension.js` (UI + state machine) and `subprocess.js` (all CLI spawning). Three classes:

- `TwingateGnomeExtension extends Extension` (extension.js) — GNOME's lifecycle hooks. `enable()` constructs the indicator and adds it to `Main.panel`; `disable()` just calls `_indicator.destroy()`. GNOME 45+ disables extensions on lock screen, so `disable()` runs frequently — leaks here matter.
- `TwingateIndicator extends PanelMenu.Button` (extension.js, registered via `GObject.registerClass`) — the UI and state machine. It **overrides `destroy()`** (there is no separate `stop()`): the override releases every non-actor resource (poll source via `_removeFileWatch()`, the `TwingateCli` via `_cli.destroy()`, the copy timer, open dialogs) and then calls `super.destroy()`, which tears down the actor tree and — because every persistent signal is wired with `connectObject(..., this)` — auto-disconnects all handlers. No manual `disconnect()` bookkeeping.
- `TwingateCli` (subprocess.js) — wraps every `Gio.Subprocess`/`pkexec` spawn behind three methods (`spawn`/`run`/`runPrivileged`) plus `destroy()`. See "The subprocess module".

### Connection-state model

State is derived, not stored by Twingate for us. The extension polls `GLib.file_test('/run/twingate/auth.sock', EXISTS)` on a `GLib.timeout_add` loop and flips `_connected` when the socket appears/disappears. There is no D-Bus or systemd API call to query state.

Two poll cadences, defined as module-level constants near the top of `extension.js`:
- `SLOW_POLL_MS` (10s) — steady-state background watch.
- `FAST_POLL_MS` (1s) — armed by `_armFastPoll()` (called from `_daemon` on a successful privileged action) so the UI catches up quickly after the user starts/stops the service. The `onChange` callback passed into `_addFileWatch` swaps back to slow polling on the *next* state transition.

`_addFileWatch` self-guards the single-active-timeout invariant: it calls `_removeFileWatch()` before assigning `_pollerTimeoutHandle`, so callers never have to (per EGO's "remove main-loop sources" guideline). The `_copyText` "copied" timer is likewise removed-before-recreated via `_resetCopyIcon()`.

### Menu actions and the CLI surface

The panel menu exposes a curated subset of the `twingate` CLI. Interactive/admin subcommands (`setup`, `config`, `account add`, `kube`, `ssh`) are deliberately excluded — they need a terminal, args, or browser flow and can't work as fire-and-forget clicks.

Two state-changing items, both context-aware (label + action swap on `_connected` in `_setUiState`) and both routed through `_daemon(...)` (which arms the fast poll on success) so the socket-poll catches the result quickly:
- `_handleToggle` — full connect/disconnect. The daemon step goes through pkexec (`twingate service-start` / `service-stop`); on success it fires the user-level follow-up (`twingate start` / `twingate desktop-stop`).
- `_handlePause` — pause/resume that keeps tokens: pkexec `twingate service-stop` / pkexec `twingate service-start` + `twingate connect`.

**Why pkexec, not `twingate start`/`stop` directly:** the daemon (`twingate.service`) is root-owned, and `twingate start`/`stop`/`connect`/`disconnect` all shell out to `sudo twingate service-start`/`service-stop` internally. Spawned from GNOME Shell there is no controlling terminal, so that sudo aborts (`sudo: a terminal is required to read the password`) — the earlier fire-and-forget `GLib.spawn_command_line_async('twingate start')` did nothing and tripped apport ("Ubuntu has encountered an issue"). Instead `_daemon(privilegedArgv, followUpArgv)` `await`s `this._cli.runPrivileged(privilegedArgv)` — which runs `pkexec twingate service-…`, popping the desktop's polkit admin-password modal via gnome-shell's polkit agent — and only on success (and if `!this._cli.cancelled`, so a teardown during the password prompt is a no-op) arms the fast poll and fires the user-level follow-up. The follow-ups need no sudo because the daemon is already in the target state (verified: `twingate start` with the daemon up, and user-level `connect`/`desktop-*`, never invoke sudo). Cancelling the password dialog leaves state untouched. **The only privileged operation is the systemd daemon start/stop** — everything else (connect handshake, tokens, desktop notifier) is user-level.

### The subprocess module

`subprocess.js` exports one class, `TwingateCli`, and the indicator owns a single instance (`this._cli`, torn down in `destroy()`). It isolates every `Gio.Subprocess` call so the UI code stays declarative and reviewers have one place to audit spawning. It holds a `Set` of live procs and a shared `Gio.Cancellable`; `Gio._promisify` is applied to `communicate_utf8_async`/`wait_async` at module load so the methods are `await`able. Three spawn methods plus teardown:
- `spawn(argv)` — fire-and-forget (no shell quoting), used for actions taking a user-derived name (`exit-node switch`, `account switch`, `auth`, one-shot notifier commands). Waits async only to drop the proc from the tracking set.
- `run(argv)` — resolves with stdout, or `null` if the spawn failed / the command exited non-zero / the read was cancelled. Used by `_loadVersion`, `_loadUser`, `_loadResources`, and the command-dialog list load.
- `runPrivileged(argv)` — prepends `pkexec` and resolves `true` only if the user authenticated and the command exited 0.
- `destroy()` — cancels the shared cancellable (so awaited callers see `cancelled === true` and stop touching the disposed indicator — `force_exit` does **not** cancel an already-queued async finish) and `force_exit()`s every live proc.

A private `_launch(argv, flags)` centralizes `Gio.Subprocess.new`; the **one** legitimate `try/catch` there logs via `console.error` and returns `null` so a missing `twingate`/`pkexec` degrades to a "Failed to load" UI instead of an unhandled rejection. This is deliberate error handling — distinct from the pointless `try/catch` around `disconnect()`/`force_exit()` that EGO's anti-AI-slop guideline (correctly) flags; those are gone.

**Submenu caveat:** `PopupSubMenuMenuItem` submenus do **not expand in a nested shell** (`gnome-shell --nested`) — confirmed via logging: the top menu opened and `_setUiState` ran, but the submenu's `open-state-changed` never emitted. They work fine in a real logged-in session (GNOME's own menus use them everywhere). So anything that must be testable in the nested dev shell uses a modal, while fixed command groups the user accepted verifying in a real session use submenus.

Exit node and Account therefore open **modal dialogs**: flat `PopupMenuItem`s (`_exitNodeItem` gated on `_connected`, `_accountItem` always live) that call `_openCommandDialog(...)`.

Service and Notifications are **submenus** (`_serviceMenu` / `_notifMenu`, built by `_buildCommandSubMenu(title, entries)`) of fixed one-shot commands: Service → `service-start`/`service-stop` (no `service-restart` exists in the CLI); Notifications → `desktop-start`/`desktop-stop`/`desktop-restart`. Each entry is `{label, argv, privileged?}`. Entries flagged `privileged: true` (the root-owned Service commands) go through `_daemon(argv)` (pkexec) for the same reason as the toggle; Notifications are user-level and go through `this._cli.spawn(argv)`. Child items wire their `activate` via `connectObject(..., this)`, so they need no manual handle tracking — `super.destroy()` disconnects them when the indicator is destroyed.

`_openCommandDialog({title, topActions, listArgv, listHeader, skip, emptyText, onPick, extraButtons, parse})` is the shared modal: optional fixed action rows on top (exit-node start/stop, plain `_rowbtn` action buttons), then a `listArgv`-loaded list of names each running `onPick(name)`, plus optional dialog buttons (account's Logout). The list is rendered as a **single-column table** matching the Resources modal — a `listHeader` row (`_thead`/`_hcell`) over zebra-striped, border-separated rows. **Each row must mirror the Resources row structure exactly** — a `_trow` `St.BoxLayout` wrapping a single `_cell`/`_namebtn` `St.Button` whose label is `x_align: START` + ellipsized — so the data's left edge lines up with the `_hcell` header (both at 8px). Do **not** make the row itself the button (an earlier version did, and the button-vs-boxlayout structural mismatch threw the header out of alignment). It's tracked in `this._cmdDialog` (separate from the resources `this._dialog`), closed when going offline, and destroyed in `destroy()`. List parsing defaults to `_parseList(out, skipSubstrings)` (a best-effort splitter dropping blanks, "no …" lines, and leading markers) but callers can pass a custom `parse(out)` returning the cleaned names. **Account uses `parse: _parseAccountEmails`** because `twingate account list` is a 3-column table (`EMAIL <tab> NETWORK <tab> NETWORK URL`) — it drops the header row and returns the email column (a valid `account switch <account-id>` identifier, which accepts email / email:tenant_slug / account ID). `_loadVersion` fills one info line from `twingate version`; `_loadUser` fills the **Current User** line (`_userItem`) from the first email of `account list` via the same `_parseAccountEmails` (loaded once at construction, like the version line). Both are `async` and bail if `this._cli.cancelled` after the `await`, so a load resolving after `disable()` never writes to a disposed menu item. The Resources modal title is "Resources" (no "Twingate" prefix); the command dialogs are titled "Exit node" / "Account".

### Icon rendering

Icon swap is a plain `icon_name` change on a single `St.Icon` (styled `system-status-icon`): `_setUiState` sets `this.icon.icon_name` to `ICON_ON` (`network-vpn-symbolic`) or `ICON_OFF` (`network-vpn-disabled-symbolic`) — stock Adwaita symbolic icons, so nothing is bundled. This replaced an earlier `background-image: url("icons/*.png")` CSS approach that shipped a raster `icons/` folder; EGO flagged those as unnecessary files, and symbolic icons also track the panel's theme/scale for free. Adding new visual states means picking another named symbolic icon, not adding files. If a themed status icon ever proves insufficient, prefer a bundled **symbolic SVG** loaded via `Gio.icon_new_for_string` over raster PNGs.

GNOME loads every enabled extension's `stylesheet.css` into one shared `St` theme — selectors are global, not namespaced per extension. The remaining `twingate_gnome_local_*` classes (dialogs/table) are deliberately namespaced so they don't collide with any other Twingate-related extension a user might have installed. Keep them unique.

### Resources modal

The panel menu has a single `Resources…` item (`_resourcesItem`) that opens a `ModalDialog` (`resource:///org/gnome/shell/ui/modalDialog.js`) — chosen over an inline `PopupSubMenuMenuItem` because the submenu was cramped and hid each resource's address. The dialog holds a title bar (`_dialogTitleBar`: heading + top-right ✕ close button), a search `St.Entry`, and a scrollable `St.ScrollView` → `St.BoxLayout` containing a **table**: a header row (`twingate_gnome_local_thead`, styled distinct) plus one data row per resource (`twingate_gnome_local_trow`, zebra-striped via `_trow_alt` on odd rows, `border-bottom` separators). Columns are Name / Address / Alias / Auth. Alignment works because header and data cells share fixed-width column classes (`_c_name` / `_c_alias` / `_c_auth`); the Address column has no fixed width and `x_expand`s to fill the rest — so all four cells must keep matching classes/expand flags between `_headerCell` and `_valueCell` or the columns drift. **Critical:** in St, CSS `width` is only a *preferred* width — a wrapping label reports a large minimum width (longest word/URL) that forces its cell wider than the column, drifting everything to its right. So the fixed-width columns (Name button label, Alias, Auth) must `ellipsize` (`Pango.EllipsizeMode.END`, line-wrap off) — that drops the label's min width to ~0 so the CSS `width` is actually honored. Only the expanding Address column keeps `set_line_wrap(true)`, since it has flexible width to absorb. If you add a fixed column, ellipsize its label or it will misalign with long data. The Name cell is an `St.Button` (runs `twingate auth <name>`); Address and Alias cells (`_valueCell` with copyable=true) carry a copy button that writes the value to the clipboard via `St.Clipboard` and briefly swaps its icon to a checkmark (`_copyText` / `_resetCopyIcon`, a tracked single-shot timeout cleaned up on re-render, and `_cancelCopyReset` — which clears the timer without touching the icon — on dialog close and `destroy()`). Typing filters (`_renderResourceList` re-renders against name/address/alias); Enter authenticates the first match. The `name/address/alias/auth` column mapping is an assumption from `_parseResources` — the header row makes a mismatch obvious; fix the parse if the CLI columns differ. The scroll area's `height` is **not** in CSS — it's set in JS via `_dialogScrollHeight()` (`min(600, monitor.height − 320)`, floor 160) on both this dialog and the command dialog, so the whole modal fits the screen and the dialog's action buttons (Refresh/Close) stay visible instead of overflowing off the bottom. Only `min-width` stays in the `_scroll` CSS class.

Data flow: `_loadResources(force, onComplete)` runs `twingate -d resources` via `Gio.Subprocess` (STDOUT_PIPE) and `_parseResources` turns the tab-separated output into `this._resources`. Loading is lazy — prefetched when the panel menu opens (so the dialog is instant) and re-run on demand by the dialog's Refresh button. `_renderResourceList` reads `_resourcesLoading` / `_resourcesError` / `_resources` to show Loading / Failed / list / empty states, so it's safe to call before, during, and after a load. The header row is detected by the `RESOURCE NAME` literal — if Twingate ever changes the column header the parse will treat the header as a row, so keep that check in sync with the CLI output.

Lifecycle: the dialog is created lazily with `destroyOnClose: true`; its `destroy` handler nulls `_dialog`/`_searchEntry`/`_listBox` so stale references never leak. `_setUiState` closes the dialog and clears the cache when going offline, and `setSensitive` greys out `Resources…` while disconnected. `destroy()` destroys any open dialog. CSS classes are namespaced `twingate_gnome_local_*` for the global-theme reason noted above.

### Things to know when modifying

- `metadata.json` `shell-version` is `["46"]` only — bump deliberately after testing.
- GObject type names must stay unique per process — all GNOME extensions share one shell process. `TwingateIndicator` is registered with an explicit `GTypeName: 'TwingateGnomeLocalIndicator'` precisely so it can coexist with other Twingate-related extensions (a plain class name like `TwingateIndicator` would collide with another extension using the same name, and whichever loads second fails with `Type name … is already registered`). Keep this `GTypeName` unique and namespaced; do not drop it.
- ESLint config uses `globals.browser`, which is wrong for GJS (no `window`/`document`). If you tighten lint rules, switch to a GJS-appropriate global set or the extension globals will trip false positives.
- ESLint default config flags `_e` catch parameters as unused. The codebase uses bare `catch {}` (ES2019) for ignored errors — keep that style or configure `argsIgnorePattern: "^_"`.
