// All Twingate CLI subprocess plumbing lives here so the UI code in
// extension.js stays declarative. One TwingateCli instance is owned by the
// panel indicator; destroy() cancels in-flight reads and kills live procs.

import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

export class TwingateCli {
    constructor() {
        // Live procs, so destroy() can force_exit anything still running.
        this._procs = new Set();
        // Cancels in-flight reads so their awaited callers stop touching the
        // (about to be destroyed) indicator after disable().
        this._cancellable = new Gio.Cancellable();
    }

    get cancelled() {
        return this._cancellable.is_cancelled();
    }

    // Launch argv and track the proc. Returns null (and logs) if the program
    // can't be spawned — e.g. the Twingate CLI or pkexec isn't installed.
    _launch(argv, flags) {
        try {
            const proc = Gio.Subprocess.new(argv, flags);
            this._procs.add(proc);
            return proc;
        } catch (e) {
            console.error(`twingate-gnome: failed to spawn ${argv.join(' ')}: ${e.message}`);
            return null;
        }
    }

    // Fire-and-forget: run argv (no shell) and ignore the result. Used for
    // actions that report through Twingate's own UI (auth, switch, logout…).
    spawn(argv) {
        const proc = this._launch(argv, Gio.SubprocessFlags.NONE);
        proc?.wait_async(this._cancellable, () => this._procs.delete(proc));
    }

    // Run argv and resolve with stdout, or null if the spawn failed, the
    // command exited non-zero, or the read was cancelled.
    async run(argv) {
        const proc = this._launch(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
        if (!proc)
            return null;
        let stdout;
        try {
            [stdout] = await proc.communicate_utf8_async(null, this._cancellable);
        } catch {
            return null; // cancelled during teardown, or read failure
        }
        this._procs.delete(proc);
        return proc.get_successful() ? (stdout ?? '') : null;
    }

    // Run a root-requiring subcommand through pkexec, which pops the desktop's
    // polkit admin-password dialog via gnome-shell's polkit agent. Resolves true
    // only if the user authenticated and the command exited 0; cancelling the
    // password dialog resolves false and leaves the current state untouched.
    async runPrivileged(argv) {
        const proc = this._launch(['pkexec', ...argv], Gio.SubprocessFlags.NONE);
        if (!proc)
            return false;
        try {
            await proc.wait_async(this._cancellable);
        } catch {
            return false;
        }
        this._procs.delete(proc);
        return proc.get_successful();
    }

    destroy() {
        this._cancellable.cancel();
        for (const proc of this._procs)
            proc.force_exit();
        this._procs.clear();
    }
}
