import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { TwingateCli } from './subprocess.js';


export default class TwingateGnomeExtension extends Extension {
    enable() {
        this._indicator = new TwingateIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

const SOCKET_PATH = '/run/twingate/auth.sock';
// Stock Adwaita symbolic icons — no bundled raster icons to ship.
const ICON_ON = 'network-vpn-symbolic';
const ICON_OFF = 'network-vpn-disabled-symbolic';
const FAST_POLL_MS = 1000;
const SLOW_POLL_MS = 10000;

const TwingateIndicator = GObject.registerClass(
    { GTypeName: 'TwingateGnomeLocalIndicator' },
    class TwingateIndicator extends PanelMenu.Button {
        constructor() {
            super(0.0, 'Twingate Status');

            // All subprocess spawning goes through this; destroy() tears it down.
            this._cli = new TwingateCli();

            this._connected = false;
            this._resources = [];
            this._resourcesLoaded = false;
            this._resourcesLoading = false;
            this._resourcesError = false;

            // Modal dialog widgets (created lazily in _openResourcesDialog).
            this._dialog = null;
            this._searchEntry = null;
            this._listBox = null;
            this._firstMatchName = null;

            // Generic command-list dialog (exit node / account).
            this._cmdDialog = null;

            // Transient "copied" feedback on a row's copy button.
            this._copyResetTimeout = null;
            this._copiedIcon = null;

            this.icon = new St.Icon({ icon_name: ICON_OFF, style_class: 'system-status-icon' });
            this.add_child(this.icon);

            this._statusItem = new PopupMenu.PopupMenuItem('Status: offline', { reactive: false });
            this.menu.addMenuItem(this._statusItem);

            // Full connect/disconnect (start/stop).
            this._toggleItem = new PopupMenu.PopupMenuItem('Connect');
            this._toggleItem.connectObject('activate', () => this._handleToggle(), this);
            this.menu.addMenuItem(this._toggleItem);

            // Pause (disconnect) / Reconnect (connect) — keeps tokens.
            this._pauseItem = new PopupMenu.PopupMenuItem('Pause (keep tokens)');
            this._pauseItem.connectObject('activate', () => this._handlePause(), this);
            this.menu.addMenuItem(this._pauseItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._resourcesItem = new PopupMenu.PopupMenuItem('Resources…');
            this._resourcesItem.connectObject('activate', () => this._openResourcesDialog(), this);
            this._resourcesItem.setSensitive(false);
            this.menu.addMenuItem(this._resourcesItem);

            // Exit node routing — opens a modal (submenus don't render reliably).
            this._exitNodeItem = new PopupMenu.PopupMenuItem('Exit node…');
            this._exitNodeItem.connectObject('activate', () => this._openExitNodeDialog(), this);
            this._exitNodeItem.setSensitive(false);
            this.menu.addMenuItem(this._exitNodeItem);

            // Account — opens a modal.
            this._accountItem = new PopupMenu.PopupMenuItem('Account…');
            this._accountItem.connectObject('activate', () => this._openAccountDialog(), this);
            this.menu.addMenuItem(this._accountItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Daemon + notifier controls, grouped into submenus.
            this._serviceMenu = this._buildCommandSubMenu('Service', [
                { label: 'Start', argv: ['twingate', 'service-start'], privileged: true },
                { label: 'Stop', argv: ['twingate', 'service-stop'], privileged: true },
            ]);
            this._notifMenu = this._buildCommandSubMenu('Notifications', [
                { label: 'Start', argv: ['twingate', 'desktop-start'] },
                { label: 'Stop', argv: ['twingate', 'desktop-stop'] },
                { label: 'Restart', argv: ['twingate', 'desktop-restart'] },
            ]);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._userItem = new PopupMenu.PopupMenuItem('User: …', { reactive: false });
            this.menu.addMenuItem(this._userItem);

            this._versionItem = new PopupMenu.PopupMenuItem('twingate', { reactive: false });
            this.menu.addMenuItem(this._versionItem);

            // Prefetch the resource list when the menu opens so the dialog is instant.
            this.menu.connectObject('open-state-changed', (_menu, open) => {
                if (open && this._connected && !this._resourcesLoaded && !this._resourcesLoading)
                    this._loadResources(false);
            }, this);

            this._loadVersion();
            this._loadUser();
            this._addFileWatch(SLOW_POLL_MS);
        }

        _setUiState() {
            if (this._connected) {
                this.icon.icon_name = ICON_ON;
                this._statusItem.label.text = 'Status: online';
                this._toggleItem.label.text = 'Disconnect';
                this._pauseItem.label.text = 'Pause (keep tokens)';
                this._resourcesItem.setSensitive(true);
                this._exitNodeItem.setSensitive(true);
            } else {
                this.icon.icon_name = ICON_OFF;
                this._statusItem.label.text = 'Status: offline';
                this._toggleItem.label.text = 'Connect';
                this._pauseItem.label.text = 'Reconnect';
                this._resourcesItem.setSensitive(false);
                this._exitNodeItem.setSensitive(false);
                this._resources = [];
                this._resourcesLoaded = false;
                this._resourcesError = false;
                // Going offline invalidates an open dialog.
                this._dialog?.close();
                this._cmdDialog?.close();
            }
        }

        _armFastPoll() {
            // Poll quickly until the next state transition, then relax to slow.
            this._addFileWatch(FAST_POLL_MS, () => this._addFileWatch(SLOW_POLL_MS));
        }

        // Bring the Twingate daemon up/down. The daemon (twingate.service) is
        // root-owned: `twingate start`/`stop` shell out to `sudo twingate
        // service-start`/`service-stop` internally, and that sudo aborts when
        // spawned without a controlling terminal ("sudo: a terminal is required to
        // read the password"). So we run the privileged step through pkexec, which
        // pops the desktop's polkit admin-password dialog, and only fire the
        // user-level follow-ups (which need no sudo once the daemon is already in
        // the target state) on success.
        _handleToggle() {
            if (this._connected)
                this._daemon(['twingate', 'service-stop'], ['twingate', 'desktop-stop']);
            else
                this._daemon(['twingate', 'service-start'], ['twingate', 'start']);
        }

        _handlePause() {
            if (this._connected)
                this._daemon(['twingate', 'service-stop']);
            else
                this._daemon(['twingate', 'service-start'], ['twingate', 'connect']);
        }

        // Run the root-requiring daemon step via pkexec, then — only if the user
        // authenticated and it succeeded — arm the fast poll and fire the
        // user-level follow-up. Bails if the extension was disabled meanwhile.
        async _daemon(privilegedArgv, followUpArgv) {
            const ok = await this._cli.runPrivileged(privilegedArgv);
            if (!ok || this._cli.cancelled)
                return;
            this._armFastPoll();
            if (followUpArgv)
                this._cli.spawn(followUpArgv);
        }

        // A submenu of one-shot command items. entries: {label, argv, privileged}.
        // `privileged` entries (root-owned daemon control) go through pkexec via
        // _daemon so the admin-password dialog appears instead of a headless sudo
        // crash; everything else is a plain user-level spawn.
        _buildCommandSubMenu(title, entries) {
            const sub = new PopupMenu.PopupSubMenuMenuItem(title);
            for (const e of entries) {
                const item = new PopupMenu.PopupMenuItem(e.label);
                item.connectObject('activate', () => {
                    if (e.privileged)
                        this._daemon(e.argv);
                    else
                        this._cli.spawn(e.argv);
                }, this);
                sub.menu.addMenuItem(item);
            }
            this.menu.addMenuItem(sub);
            return sub;
        }

        // Best-effort line parser for `list`-style CLI output. Drops blank lines,
        // any line containing one of skipSubstrings, and leading markers (* • -).
        _parseList(out, skipSubstrings) {
            return out
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0)
                .filter(l => !skipSubstrings.some(s => l.toLowerCase().includes(s)))
                .map(l => l.replace(/^[*•\-\s]+/, '').trim())
                .filter(l => l.length > 0);
        }

        async _loadVersion() {
            const out = await this._cli.run(['twingate', 'version']);
            if (this._cli.cancelled || !this._versionItem || !out)
                return;
            const first = out.split('\n').map(l => l.trim()).filter(l => l.length > 0)[0];
            if (first)
                this._versionItem.label.text = first;
        }

        // `twingate account list` is a table: EMAIL <tab> NETWORK <tab> NETWORK URL.
        // Returns the email column (a valid `account switch` identifier), header
        // row dropped.
        _parseAccountEmails(out) {
            return out
                .split('\n')
                .map(l => l.trimEnd())
                .filter(l => l.length > 0)
                .filter(l => !/^EMAIL\b/i.test(l) && !l.toLowerCase().includes('network url'))
                .map(l => l.split('\t')[0].trim())
                .filter(l => l.length > 0 && !l.toLowerCase().startsWith('no account'));
        }

        async _loadUser() {
            const out = await this._cli.run(['twingate', 'account', 'list']);
            if (this._cli.cancelled || !this._userItem || !out)
                return;
            const emails = this._parseAccountEmails(out);
            this._userItem.label.text = emails.length ? `User: ${emails[0]}` : 'User: (none)';
        }

        _openExitNodeDialog() {
            if (!this._connected)
                return;
            this._openCommandDialog({
                title: 'Exit node',
                topActions: [
                    { label: 'Start routing all traffic through Twingate', argv: ['twingate', 'exit-node', 'start'] },
                    { label: 'Stop routing all traffic through Twingate', argv: ['twingate', 'exit-node', 'stop'] },
                ],
                listArgv: ['twingate', 'exit-node', 'list'],
                listHeader: 'Exit node',
                skip: ['no exit nodes'],
                emptyText: '(no exit nodes available)',
                onPick: (name) => this._cli.spawn(['twingate', 'exit-node', 'switch', name]),
            });
        }

        _openAccountDialog() {
            this._openCommandDialog({
                title: 'Account',
                listArgv: ['twingate', 'account', 'list'],
                listHeader: 'Account',
                parse: (out) => this._parseAccountEmails(out),
                emptyText: '(no accounts)',
                onPick: (id) => this._cli.spawn(['twingate', 'account', 'switch', id]),
                extraButtons: [{ label: 'Logout', argv: ['twingate', 'account', 'logout'] }],
            });
        }

        // Generic modal: optional fixed action rows on top, then a loaded list of
        // names each running onPick(name). Used by exit-node and account. The list
        // is rendered as a single-column table (header + zebra-striped, bordered
        // rows) to match the Resources modal; topActions stay as plain action rows.
        _openCommandDialog({ title, topActions = [], listArgv, listHeader, skip = [], emptyText = '(none)', onPick, extraButtons = [], parse }) {
            const parseFn = parse || ((out) => this._parseList(out, skip));
            this._cmdDialog?.close();

            const dialog = new ModalDialog.ModalDialog({
                destroyOnClose: true,
                styleClass: 'twingate_gnome_local_dialog',
            });
            this._cmdDialog = dialog;

            dialog.contentLayout.add_child(this._dialogTitleBar(title, dialog));

            const scroll = new St.ScrollView({
                style_class: 'twingate_gnome_local_scroll',
                x_expand: true,
                y_expand: true,
            });
            scroll.style = `height: ${this._dialogScrollHeight()}px;`;
            const listBox = new St.BoxLayout({ vertical: true, x_expand: true });
            scroll.set_child(listBox);
            dialog.contentLayout.add_child(scroll);

            // Plain action button (used for the fixed top actions).
            const addActionRow = (label, onClick) => {
                const btn = new St.Button({
                    style_class: 'twingate_gnome_local_rowbtn',
                    x_expand: true,
                    can_focus: true,
                    track_hover: true,
                });
                btn.set_child(new St.Label({
                    text: label,
                    style_class: 'twingate_gnome_local_name',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.START,
                }));
                btn.connect('clicked', onClick);
                listBox.add_child(btn);
            };
            // Distinct header row for the loaded list (matches Resources table).
            const addListHeader = () => {
                if (!listHeader)
                    return;
                const header = new St.BoxLayout({ style_class: 'twingate_gnome_local_thead', x_expand: true });
                header.add_child(new St.Label({ text: listHeader, style_class: 'twingate_gnome_local_hcell', x_expand: true }));
                listBox.add_child(header);
            };
            // Zebra-striped, bordered table row that is also clickable. Structured
            // exactly like the Resources table (row box → cell button → label) so
            // the header (_hcell) and data (_cell) share the same left offset.
            const addListRow = (label, index, onClick) => {
                const rowClass = index % 2
                    ? 'twingate_gnome_local_trow twingate_gnome_local_trow_alt'
                    : 'twingate_gnome_local_trow';
                const row = new St.BoxLayout({ style_class: rowClass, x_expand: true });
                const btn = new St.Button({
                    style_class: 'twingate_gnome_local_cell twingate_gnome_local_namebtn',
                    x_expand: true,
                    can_focus: true,
                    track_hover: true,
                });
                const lbl = new St.Label({
                    text: label,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.START,
                });
                lbl.clutter_text.set_line_wrap(false);
                lbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                btn.set_child(lbl);
                btn.connect('clicked', onClick);
                row.add_child(btn);
                listBox.add_child(row);
            };
            const addMessage = (text) => listBox.add_child(new St.Label({
                text,
                style_class: 'twingate_gnome_local_empty',
            }));

            const renderTop = () => {
                for (const a of topActions)
                    addActionRow(a.label, () => { this._cli.spawn(a.argv); dialog.close(); });
                if (topActions.length)
                    listBox.add_child(new St.Label({ text: '', style_class: 'twingate_gnome_local_empty' }));
            };

            renderTop();
            addListHeader();
            addMessage('Loading…');

            this._cli.run(listArgv).then((out) => {
                if (this._cmdDialog !== dialog)
                    return;
                listBox.remove_all_children();
                renderTop();
                addListHeader();
                if (out === null) {
                    addMessage('Failed to load');
                    return;
                }
                const names = parseFn(out);
                if (names.length === 0) {
                    addMessage(emptyText);
                    return;
                }
                names.forEach((name, i) =>
                    addListRow(name, i, () => { onPick(name); dialog.close(); }));
            });

            const buttons = extraButtons.map(b => ({
                label: b.label,
                action: () => { this._cli.spawn(b.argv); dialog.close(); },
            }));
            buttons.push({ label: 'Close', action: () => dialog.close(), key: Clutter.KEY_Escape });
            dialog.setButtons(buttons);

            dialog.connect('destroy', () => {
                if (this._cmdDialog === dialog)
                    this._cmdDialog = null;
            });
            dialog.open();
        }

        _parseResources(stdout) {
            const rows = [];
            const lines = stdout.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Drop the column header wherever it lands (tolerates a leading
                // banner/blank line before it).
                if (line.includes('RESOURCE NAME'))
                    continue;
                const cols = line.split('\t').map(c => c.trim());
                if (!cols[0])
                    continue;
                rows.push({
                    name: cols[0],
                    address: cols[1] ?? '',
                    alias: cols[2] ?? '',
                    auth: cols[3] ?? '',
                });
            }
            return rows;
        }

        async _loadResources(force, onComplete) {
            if (!this._connected) {
                this._resources = [];
                onComplete?.();
                return;
            }
            if (this._resourcesLoading)
                return;
            if (this._resourcesLoaded && !force) {
                onComplete?.();
                return;
            }

            this._resourcesLoading = true;
            this._resourcesError = false;
            this._renderResourceList();

            const stdout = await this._cli.run(['twingate', '-d', 'resources']);
            if (this._cli.cancelled)
                return;
            this._resourcesLoading = false;
            if (stdout === null) {
                this._resourcesError = true;
            } else {
                this._resources = this._parseResources(stdout);
                this._resourcesLoaded = true;
            }
            this._renderResourceList();
            onComplete?.();
        }

        _activateResource(name) {
            this._cli.spawn(['twingate', 'auth', name]);
            this._dialog?.close();
        }

        // Cancel a pending "copied" revert timer and forget the tracked icon
        // without touching it — used when the dialog (and its icon) is torn down.
        _cancelCopyReset() {
            if (this._copyResetTimeout) {
                GLib.Source.remove(this._copyResetTimeout);
                this._copyResetTimeout = null;
            }
            this._copiedIcon = null;
        }

        // Revert the copy button glyph from the checkmark back to the copy icon
        // while the dialog is still alive, then clear the timer.
        _resetCopyIcon() {
            if (this._copiedIcon)
                this._copiedIcon.icon_name = 'edit-copy-symbolic';
            this._cancelCopyReset();
        }

        _copyText(text, icon) {
            if (!text)
                return;
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);

            this._resetCopyIcon();
            if (icon) {
                icon.icon_name = 'object-select-symbolic';
                this._copiedIcon = icon;
                this._copyResetTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                    this._copyResetTimeout = null;
                    this._resetCopyIcon();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }

        _dialogMessage(text) {
            this._listBox.add_child(new St.Label({
                text,
                style_class: 'twingate_gnome_local_empty',
            }));
        }

        _renderResourceList() {
            if (!this._listBox)
                return;
            this._resetCopyIcon();
            this._listBox.remove_all_children();
            this._firstMatchName = null;

            if (this._resourcesLoading) {
                this._dialogMessage('Loading…');
                return;
            }
            if (this._resourcesError) {
                this._dialogMessage('Failed to load resources');
                return;
            }

            const filter = (this._searchEntry?.get_text() ?? '').trim().toLowerCase();
            const matches = this._resources.filter(r => {
                if (!filter)
                    return true;
                return r.name.toLowerCase().includes(filter)
                    || r.address.toLowerCase().includes(filter)
                    || r.alias.toLowerCase().includes(filter);
            });

            if (matches.length === 0) {
                this._dialogMessage(this._resources.length ? 'No matching resources' : 'No resources');
                return;
            }

            this._firstMatchName = matches[0].name;

            // Header row.
            const header = new St.BoxLayout({ style_class: 'twingate_gnome_local_thead', x_expand: true });
            header.add_child(this._headerCell('Name', 'twingate_gnome_local_c_name', false));
            header.add_child(this._headerCell('Address', 'twingate_gnome_local_c_addr', true));
            header.add_child(this._headerCell('Alias', 'twingate_gnome_local_c_alias', false));
            header.add_child(this._headerCell('Auth', 'twingate_gnome_local_c_auth', false));
            this._listBox.add_child(header);

            // Data rows.
            matches.forEach((r, i) => {
                const rowClass = i % 2
                    ? 'twingate_gnome_local_trow twingate_gnome_local_trow_alt'
                    : 'twingate_gnome_local_trow';
                const row = new St.BoxLayout({ style_class: rowClass, x_expand: true });

                // Name cell — clicking it authenticates the resource.
                const nameBtn = new St.Button({
                    style_class: 'twingate_gnome_local_cell twingate_gnome_local_c_name twingate_gnome_local_namebtn',
                    can_focus: true,
                    track_hover: true,
                });
                const nameLabel = new St.Label({ text: r.name, x_expand: true, x_align: Clutter.ActorAlign.START });
                nameLabel.clutter_text.set_line_wrap(false);
                nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                nameBtn.set_child(nameLabel);
                nameBtn.connect('clicked', () => this._activateResource(r.name));
                row.add_child(nameBtn);

                // Address / Alias are copyable; Auth is plain.
                row.add_child(this._valueCell(r.address, 'twingate_gnome_local_c_addr', true, true));
                row.add_child(this._valueCell(r.alias, 'twingate_gnome_local_c_alias', false, true));
                row.add_child(this._valueCell(r.auth, 'twingate_gnome_local_c_auth', false, false));

                this._listBox.add_child(row);
            });
        }

        _headerCell(text, columnClass, expand) {
            return new St.Label({
                text,
                style_class: `twingate_gnome_local_hcell ${columnClass}`,
                x_expand: !!expand,
            });
        }

        // A table cell holding a value, optionally with a copy-to-clipboard button.
        _valueCell(value, columnClass, expand, copyable) {
            const cell = new St.BoxLayout({
                style_class: `twingate_gnome_local_cell ${columnClass}`,
                x_expand: !!expand,
            });

            const label = new St.Label({ text: value || '—', x_expand: true });
            if (expand) {
                // Flexible column (Address): wrap to use the leftover width.
                label.clutter_text.set_line_wrap(true);
            } else {
                // Fixed-width column: ellipsize so long values can't push the
                // column wider than its CSS width and misalign the header.
                label.clutter_text.set_line_wrap(false);
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            }
            cell.add_child(label);

            if (copyable && value) {
                const copyIcon = new St.Icon({
                    icon_name: 'edit-copy-symbolic',
                    style_class: 'popup-menu-icon',
                });
                const copyBtn = new St.Button({
                    style_class: 'twingate_gnome_local_copy',
                    can_focus: true,
                    track_hover: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                copyBtn.set_child(copyIcon);
                copyBtn.connect('clicked', () => this._copyText(value, copyIcon));
                cell.add_child(copyBtn);
            }

            return cell;
        }

        // Scroll-area height sized to the screen so the dialog (title + search +
        // scroll + buttons) always fits and the action buttons stay visible.
        // Reserves ~320px for the title bar, search/top rows, buttons, and padding.
        _dialogScrollHeight() {
            const monitor = Main.layoutManager.primaryMonitor;
            const avail = monitor ? monitor.height : 720;
            return Math.max(160, Math.min(600, avail - 320));
        }

        // A title row with the dialog heading on the left and a close ✕ on the right.
        _dialogTitleBar(title, dialog) {
            const bar = new St.BoxLayout({
                style_class: 'twingate_gnome_local_titlebar',
                x_expand: true,
            });
            bar.add_child(new St.Label({
                text: title,
                style_class: 'twingate_gnome_local_title',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const closeBtn = new St.Button({
                style_class: 'twingate_gnome_local_close',
                can_focus: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            closeBtn.set_child(new St.Icon({
                icon_name: 'window-close-symbolic',
                style_class: 'popup-menu-icon',
            }));
            closeBtn.connect('clicked', () => dialog.close());
            bar.add_child(closeBtn);
            return bar;
        }

        _openResourcesDialog() {
            if (!this._connected)
                return;
            // One dialog at a time.
            if (this._dialog) {
                this._dialog.open();
                return;
            }

            const dialog = new ModalDialog.ModalDialog({
                destroyOnClose: true,
                styleClass: 'twingate_gnome_local_dialog',
            });
            this._dialog = dialog;

            dialog.contentLayout.add_child(this._dialogTitleBar('Resources', dialog));

            const entry = new St.Entry({
                hint_text: 'Search resources…',
                can_focus: true,
                x_expand: true,
                style_class: 'twingate_gnome_local_search',
            });
            this._searchEntry = entry;
            entry.clutter_text.connect('text-changed', () => this._renderResourceList());
            entry.clutter_text.connect('activate', () => {
                if (this._firstMatchName)
                    this._activateResource(this._firstMatchName);
            });
            dialog.contentLayout.add_child(entry);

            const scroll = new St.ScrollView({
                style_class: 'twingate_gnome_local_scroll',
                x_expand: true,
                y_expand: true,
            });
            scroll.style = `height: ${this._dialogScrollHeight()}px;`;
            const listBox = new St.BoxLayout({ vertical: true, x_expand: true });
            this._listBox = listBox;
            scroll.set_child(listBox);
            dialog.contentLayout.add_child(scroll);

            dialog.setButtons([
                {
                    label: 'Refresh',
                    action: () => this._loadResources(true),
                },
                {
                    label: 'Close',
                    action: () => dialog.close(),
                    key: Clutter.KEY_Escape,
                },
            ]);

            // destroyOnClose tears down the actor; drop our references with it.
            dialog.connect('destroy', () => {
                this._cancelCopyReset();
                this._dialog = null;
                this._searchEntry = null;
                this._listBox = null;
                this._firstMatchName = null;
            });

            dialog.open();
            entry.grab_key_focus();

            this._renderResourceList();
            if (!this._resourcesLoaded)
                this._loadResources(false);
        }

        _addFileWatch(pollInterval, onChange) {
            // Never stack sources — drop any existing poll before arming a new one.
            this._removeFileWatch();
            this._pollerTimeoutHandle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, pollInterval, () => {
                const connected = GLib.file_test(SOCKET_PATH, GLib.FileTest.EXISTS);
                if (connected !== this._connected) {
                    this._connected = connected;
                    this._setUiState();
                    onChange?.();
                }
                return GLib.SOURCE_CONTINUE;
            });
        }

        _removeFileWatch() {
            if (this._pollerTimeoutHandle) {
                GLib.Source.remove(this._pollerTimeoutHandle);
                this._pollerTimeoutHandle = null;
            }
        }

        // Overrides PanelMenu.Button.destroy(); called from the extension's
        // disable(). Releases every non-actor resource (poll source, in-flight
        // subprocesses, copy timer, open dialogs), then chains up so GObject tears
        // down the actor tree and auto-disconnects all connectObject() handlers.
        destroy() {
            this._removeFileWatch();
            this._cli.destroy();
            this._cancelCopyReset();

            this._dialog?.destroy();
            this._dialog = null;
            this._cmdDialog?.destroy();
            this._cmdDialog = null;

            super.destroy();
        }
    }
);
