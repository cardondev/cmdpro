// Builds the virtual machine image: system directories, /etc, /dev, /proc, commands, challenge fixtures.
import { VFS, Inode, ELF_HEADER } from './vfs.js';
import { b64ToBin } from './bytes.js';
import { buildRegistry } from './commands/index.js';

const PASSWD = `root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
bin:x:2:2:bin:/bin:/usr/sbin/nologin
sys:x:3:3:sys:/dev:/usr/sbin/nologin
sync:x:4:65534:sync:/bin:/bin/sync
games:x:5:60:games:/usr/games:/usr/sbin/nologin
man:x:6:12:man:/var/cache/man:/usr/sbin/nologin
lp:x:7:7:lp:/var/spool/lpd:/usr/sbin/nologin
mail:x:8:8:mail:/var/mail:/usr/sbin/nologin
news:x:9:9:news:/var/spool/news:/usr/sbin/nologin
uucp:x:10:10:uucp:/var/spool/uucp:/usr/sbin/nologin
proxy:x:13:13:proxy:/bin:/usr/sbin/nologin
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin
backup:x:34:34:backup:/var/backups:/usr/sbin/nologin
list:x:38:38:Mailing List Manager:/var/list:/usr/sbin/nologin
irc:x:39:39:ircd:/run/ircd:/usr/sbin/nologin
gnats:x:41:41:Gnats Bug-Reporting System (admin):/var/lib/gnats:/usr/sbin/nologin
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
_apt:x:100:65534::/nonexistent:/usr/sbin/nologin
`;
const GROUP = 'root:x:0:\ndaemon:x:1:\nbin:x:2:\nsys:x:3:\nadm:x:4:\ntty:x:5:\ndisk:x:6:\nlp:x:7:\nmail:x:8:\nnews:x:9:\nuucp:x:10:\nman:x:12:\nproxy:x:13:\nkmem:x:15:\ndialout:x:20:\nfax:x:21:\nvoice:x:22:\ncdrom:x:24:\nfloppy:x:25:\ntape:x:26:\nsudo:x:27:\naudio:x:29:\ndip:x:30:\nwww-data:x:33:\nbackup:x:34:\noperator:x:37:\nlist:x:38:\nirc:x:39:\nsrc:x:40:\ngnats:x:41:\nshadow:x:42:\nutmp:x:43:\nvideo:x:44:\nsasl:x:45:\nplugdev:x:46:\nstaff:x:50:\ngames:x:60:\nusers:x:100:\nnogroup:x:65534:\n';
const OS_RELEASE = 'PRETTY_NAME="CMDPRO OS 1.0 (Command Line Warrior)"\nNAME="CMDPRO OS"\nVERSION_ID="1.0"\nVERSION="1.0 (Command Line Warrior)"\nVERSION_CODENAME=warrior\nID=cmdpro\nID_LIKE="ubuntu debian rhel"\n';
const SHELLS = '# /etc/shells: valid login shells\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/bin/rbash\n/usr/bin/rbash\n/usr/bin/sh\n/bin/dash\n/usr/bin/dash\n';

const ELF = ELF_HEADER;

export class System {
  constructor({ fixtures, fsStore, game = false }) {
    this.fixtures = fixtures;
    this.fsStore = fsStore;
    this.game = game;
    this.registry = buildRegistry({ game });
    this.fixtureCache = new Map();
  }

  // Build a fresh VFS for a challenge. opts: { nobin, procs, allChallenges }
  buildFs(fixture, opts = {}) {
    const now = opts.now ?? Date.now();
    const fs = new VFS(() => (opts.clock ? opts.clock() : Date.now()));
    const root = fs.root;
    const dir = (path, mode = 0o755) => { fs.mkdir(path, '/', { parents: true }); const n = fs.stat(path, '/'); n.mode = mode; return n; };
    const file = (path, data, mode = 0o644) => { const n = fs.writeFile(path, data, '/'); n.mode = mode; return n; };
    for (const d of ['/boot', '/dev', '/etc', '/home', '/media', '/mnt', '/opt', '/proc', '/run', '/srv', '/sys', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/local/bin', '/usr/local/sbin', '/usr/share/man/man1', '/usr/share/doc', '/var/log', '/var/tmp', '/var/cache', '/var/lib', '/var/challenges', '/var/backups', '/var/local', '/var/mail', '/var/opt', '/var/spool', '/run/lock']) dir(d);
    fs.symlink('/run', '/var/run', '/');
    fs.symlink('/run/lock', '/var/lock', '/');
    dir('/root', 0o700);
    dir('/tmp', 0o1777);
    for (const [l, t] of [['/bin', 'usr/bin'], ['/sbin', 'usr/sbin'], ['/lib', 'usr/lib']]) fs.symlink(t, l, '/');
    file('/etc/passwd', PASSWD); file('/etc/group', GROUP); file('/etc/hostname', 'cmdpro\n'); file('/etc/hosts', '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n10.0.2.100\tcmdpro\n');
    file('/etc/os-release', OS_RELEASE); file('/etc/shells', SHELLS); file('/etc/timezone', 'Etc/UTC\n'); file('/etc/issue', 'CMDPRO OS 1.0 \\n \\l\n\n'); file('/etc/debian_version', 'bookworm/sid\n');
    file('/etc/resolv.conf', 'nameserver 127.0.0.53\n'); file('/etc/fstab', '# UNCONFIGURED FSTAB FOR BASE SYSTEM\n'); file('/etc/shadow', 'root:*:19000:0:99999:7:::\n', 0o640);
    file('/etc/motd', 'Welcome to CMDPRO OS. Every keystroke counts.\n');
    // devices
    for (const [name, dev] of [['null', 'null'], ['zero', 'zero'], ['random', 'urandom'], ['urandom', 'urandom'], ['tty', 'tty'], ['full', 'zero']]) { const n = new Inode('c', 0o666, now); n.dev = dev; fs.putNode('/dev/' + name, n); }
    fs.symlink('/proc/self/fd', '/dev/fd', '/');
    fs.symlink('/proc/self/fd/0', '/dev/stdin', '/');
    fs.symlink('/proc/self/fd/1', '/dev/stdout', '/');
    fs.symlink('/proc/self/fd/2', '/dev/stderr', '/');
    dir('/dev/shm', 0o1777);
    // /proc
    file('/proc/version', 'Linux version 5.15.0-cmdpro (builder@cmdpro) (gcc (Ubuntu 11.4.0) 11.4.0) #1 SMP PREEMPT_DYNAMIC\n');
    file('/proc/uptime', '3628800.42 14515201.68\n');
    file('/proc/loadavg', '0.42 0.13 0.37 1/123 1337\n');
    file('/proc/cpuinfo', [0, 1, 2, 3].map(i => `processor\t: ${i}\nvendor_id\t: GenuineIntel\nmodel name\t: CMDPRO Virtual CPU @ 3.14GHz\ncpu MHz\t\t: 3141.592\ncache size\t: 8192 KB\ncpu cores\t: 4\n\n`).join(''));
    file('/proc/meminfo', 'MemTotal:        8062712 kB\nMemFree:         5137964 kB\nMemAvailable:    6555644 kB\nBuffers:          123456 kB\nCached:          1543288 kB\nSwapTotal:       2097148 kB\nSwapFree:        2097148 kB\n');
    const procs = new Map();
    for (const p of opts.procs || []) procs.set(p.pid, { cmd: p.cmd, args: p.args || p.cmd });
    const shellPid = 1337;
    const mkProc = (pid, cmd, args) => {
      dir(`/proc/${pid}`, 0o555);
      file(`/proc/${pid}/cmdline`, (args || cmd).split(' ').join('\0') + '\0', 0o444);
      file(`/proc/${pid}/comm`, cmd.slice(0, 15) + '\n', 0o644);
      file(`/proc/${pid}/status`, `Name:\t${cmd.slice(0, 15)}\nState:\tS (sleeping)\nPid:\t${pid}\nPPid:\t1\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n`, 0o444);
      dir(`/proc/${pid}/fd`, 0o500);
    };
    mkProc(1, 'init', '/sbin/init');
    for (const [pid, p] of procs) mkProc(pid, p.cmd, p.args);
    mkProc(shellPid, 'bash', 'bash');
    fs.symlink(String(shellPid), '/proc/self', '/');
    // commands
    const exe = (path, name) => { const n = file(path, ELF + name, 0o755); n.exe = name; };
    if (!opts.nobin) {
      for (const name of this.registry.keys()) exe('/usr/bin/' + name, name);
      exe('/usr/bin/bash', 'bash');
      exe('/usr/bin/sh', 'sh');
    } else {
      exe('/usr/local/bin/bash', 'bash');
      for (const p of opts.procs || []) { const n = file('/usr/local/bin/' + p.cmd, ELF, 0o755); n.exe = null; }
      file('/usr/local/bin/runcmd', ELF, 0o755);
    }
    // challenge fixtures (current challenge, or all of them for fidelity runs)
    const loadFixture = (fx) => {
      const base = fx.dir;
      dir(base);
      const tree = this.fsStore[fx.fs] || [];
      for (const [rel, t, mode, data] of tree) {
        const p = base + '/' + rel;
        if (t === 'd') { dir(p, mode); }
        else if (t === 'l') { try { fs.symlink(data, p, '/'); } catch {} }
        else { const n = fs.writeFile(p, b64ToBin(data), '/'); n.mode = mode; }
      }
    };
    if (opts.allChallenges) {
      const seen = new Set();
      for (const fx of Object.values(this.fixtures)) { if (seen.has(fx.dir)) continue; seen.add(fx.dir); loadFixture(fx); }
    }
    if (fixture) { if (opts.allChallenges) { /* already loaded */ const tree = fs.tryResolve(fixture.dir, '/'); if (!tree) loadFixture(fixture); } else loadFixture(fixture); }
    return { fs, procs, shellPid };
  }
}
