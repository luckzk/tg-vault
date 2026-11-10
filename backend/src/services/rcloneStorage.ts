import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IStorageProvider, StorageReadOptions, StorageUploadStream, StorageUploadStreamOptions, StorageWriteOptions } from './storage/contracts.js';
import { StorageProbeError } from './storage/contracts.js';
import { trackUploadProgress } from './storage/uploadProgress.js';

/**
 * Rclone-backed storage provider.
 *
 * Credentials live encrypted in storage_accounts.config and are materialized
 * into one 0600 rclone.conf per account (RCLONE_CONFIG_DIR, default
 * /data/rclone). The token never enters argv, env, logs, or API responses:
 * rclone only ever receives `--config <path>`.
 *
 * Drime cannot report hashes or mtimes, so every size-sensitive step verifies
 * by byte count only. Vault files are not reachable with an API token.
 *
 * Drime throttles aggressively (a second consecutive listing can already 429),
 * so every rclone invocation goes through RCLONE_PACING_ARGS: at most 2 API
 * transactions per second with no burst, plus backoff retries.
 */

export interface RcloneStorageConfig {
    mode: 'drime' | 'config';
    remoteName: string;
    basePath: string;
    accessToken?: string;
    workspaceId?: string;
    rootFolderId?: string;
    rcloneConfigText?: string;
}

const REMOTE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_CONFIG_TEXT_BYTES = 64 * 1024;
const MAX_SEGMENT_BYTES = 255;
const RCLONE_MAX_PARTS = 9000;
const RCLONE_MIN_CHUNK_MIB = 5;
const STDERR_TAIL_BYTES = 64 * 1024;

/**
 * Drime 429 节流（2026-11-09 实测：`lsf` 成功后紧接着的 `lsd` 即 429，
 * Drime 未公开具体限流数字）。所有经 runRclone 发起的调用共用这组参数：
 * --tpslimit 2 --tpslimit-burst 1：单进程内每秒最多 2 次 API 事务且不突发；
 * --retries 3 --retries-sleep 5s：整操作失败后退避重试。
 * 注意 --tpslimit 只约束单个 rclone 进程内，跨进程的突发仍靠重试兜底。
 */
const RCLONE_PACING_ARGS = ['--tpslimit', '2', '--tpslimit-burst', '1', '--retries', '3', '--retries-sleep', '5s'];

/**
 * 已确认存在的远端目录（mkdir 成功后记入，1 小时内同一目录的上传不再重复 mkdir）。
 * 每个账户一个 provider 实例，key 用完整远端路径即可。进程重启后缓存清空，
 * 首个上传仍会 mkdir；目录若在 Drime 网页端被删，1 小时后自动恢复 mkdir。
 */
const CONFIRMED_DIRECTORY_TTL_MS = 3_600_000;

export function normalizeRcloneConfig(input: unknown): RcloneStorageConfig {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Rclone 配置须为对象');
    }
    const raw = input as Record<string, unknown>;
    const mode = raw.mode === undefined ? 'drime' : raw.mode;
    if (mode !== 'drime' && mode !== 'config') throw new Error('Rclone 模式只支持 drime 或 config');
    const remoteName = raw.remoteName === undefined || raw.remoteName === '' ? 'drime' : raw.remoteName;
    if (typeof remoteName !== 'string' || !REMOTE_NAME_PATTERN.test(remoteName)) {
        throw new Error('远端名称只支持 1 至 64 个字母、数字、下划线或连字符');
    }
    const basePath = normalizeBasePath(raw.basePath === undefined || raw.basePath === '' ? '/' : raw.basePath);
    const config: RcloneStorageConfig = { mode, remoteName, basePath };
    if (mode === 'drime') {
        const accessToken = raw.accessToken;
        if (typeof accessToken !== 'string' || !accessToken.trim()) throw new Error('Drime 模式需要填写 API Token');
        assertNoControlChars(accessToken, 'Drime API Token 不能包含换行或控制字符');
        config.accessToken = accessToken.trim();
        for (const key of ['workspaceId', 'rootFolderId'] as const) {
            const value = raw[key];
            if (value === undefined || value === '') continue;
            if (typeof value !== 'string') throw new Error(`${key} 须为字符串`);
            assertNoControlChars(value, `${key} 不能包含换行或控制字符`);
            config[key] = value.trim();
        }
    } else {
        const text = raw.rcloneConfigText;
        if (typeof text !== 'string' || !text.trim()) throw new Error('自定义模式需要粘贴完整的 rclone.conf 内容');
        if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_TEXT_BYTES) throw new Error('rclone.conf 内容过长');
        if (text.includes('\0')) throw new Error('rclone.conf 内容不能包含空字符');
        const sectionPattern = new RegExp(`^\\s*\\[${escapeRegExp(remoteName)}\\]\\s*$`, 'm');
        if (!sectionPattern.test(text)) throw new Error(`rclone.conf 须包含 [${remoteName}] 一节`);
        config.rcloneConfigText = text.endsWith('\n') ? text : `${text}\n`;
    }
    return config;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNoControlChars(value: string, message: string): void {
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(message);
}

/** Validates a base path such as `/` or `/TG Vault/backups`; returns a normalized posix path. */
export function normalizeBasePath(input: unknown): string {
    if (typeof input !== 'string' || !input.trim()) return '/';
    if (input.includes('\\')) throw new Error('基础路径不能包含反斜杠');
    const segments = input.split('/').filter(Boolean);
    for (const segment of segments) {
        if (segment === '.' || segment === '..') throw new Error('基础路径不能包含 . 或 ..');
        assertNoControlChars(segment, '基础路径不能包含控制字符');
        if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) throw new Error('基础路径单段不能超过 255 字节');
    }
    return segments.length ? `/${segments.join('/')}` : '/';
}

/** Validates one remote path segment (file or folder name). */
function assertSafeSegment(segment: string, label: string): void {
    if (!segment || segment === '.' || segment === '..') throw new Error(`${label}不能包含 . 或 ..`);
    if (segment.includes('\\')) throw new Error(`${label}不能包含反斜杠`);
    assertNoControlChars(segment, `${label}不能包含控制字符`);
    if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) throw new Error(`${label}不能超过 255 字节`);
}

/** Validates a stored relative path (as kept in files.path) and returns it normalized. */
function normalizeStoredPath(storedPath: string): string {
    if (!storedPath || storedPath.startsWith('/') || storedPath.includes('\\')) {
        throw new Error('存储路径不合法');
    }
    const segments = storedPath.split('/').filter(Boolean);
    if (!segments.length || segments.join('/') !== storedPath) throw new Error('存储路径不合法');
    for (const segment of segments) assertSafeSegment(segment, '存储路径段');
    return segments.join('/');
}

function joinStoredPath(folder: string | null | undefined, fileName: string): string {
    assertSafeSegment(fileName, '文件名');
    const segments: string[] = [];
    if (folder) {
        for (const segment of String(folder).split('/').filter(Boolean)) {
            assertSafeSegment(segment, '目录名');
            segments.push(segment);
        }
    }
    segments.push(fileName);
    return segments.join('/');
}

function rcloneConfigDir(): string {
    return process.env.RCLONE_CONFIG_DIR || '/data/rclone';
}

/** Drime chunk size for a known total: ceil(size / 9000) MiB, at least 5 MiB. */
export function rcloneDrimeChunkSizeMiB(totalBytes: number): number {
    return Math.max(RCLONE_MIN_CHUNK_MIB, Math.ceil(totalBytes / (RCLONE_MAX_PARTS * 1024 * 1024)));
}

interface RcloneRunResult {
    code: number;
    stdout: string;
    stderr: string;
}

class RcloneError extends Error {
    constructor(
        message: string,
        public readonly code?: number,
    ) {
        super(message);
        this.name = 'RcloneError';
    }
}

export class RcloneStorageProvider implements IStorageProvider {
    name = 'rclone';
    private readonly config: RcloneStorageConfig;
    private configPath: string | null = null;
    private configMaterialized = false;
    private readonly confirmedDirectories = new Map<string, number>();

    constructor(
        public id: string,
        configInput: unknown,
    ) {
        if (!ACCOUNT_ID_PATTERN.test(id)) throw new Error('Rclone 账户 ID 不合法');
        this.config = normalizeRcloneConfig(configInput);
    }

    /** Removes this account's materialized rclone.conf. Used for probe-only candidates. */
    async dispose(): Promise<void> {
        if (!this.configPath) return;
        try { await fs.promises.unlink(this.configPath); } catch { /* best effort */ }
        this.configPath = null;
        this.configMaterialized = false;
    }

    private renderConfigText(): string {
        if (this.config.mode === 'config') return this.config.rcloneConfigText!;
        const lines = [`[${this.config.remoteName}]`, 'type = drime', `access_token = ${this.config.accessToken}`];
        if (this.config.workspaceId) lines.push(`workspace_id = ${this.config.workspaceId}`);
        if (this.config.rootFolderId) lines.push(`root_folder_id = ${this.config.rootFolderId}`);
        return `${lines.join('\n')}\n`;
    }

    /** Writes the per-account rclone.conf atomically with 0600 permissions. */
    private async ensureConfigFile(): Promise<string> {
        if (this.configMaterialized && this.configPath) return this.configPath;
        const dir = rcloneConfigDir();
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
        await fs.promises.chmod(dir, 0o700).catch(() => undefined);
        const target = path.join(dir, `${this.id}.conf`);
        const temp = path.join(dir, `.${this.id}.${crypto.randomUUID()}.tmp`);
        const handle = await fs.promises.open(temp, 'w', 0o600);
        try {
            await handle.writeFile(this.renderConfigText(), 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.promises.chmod(temp, 0o600);
        await fs.promises.rename(temp, target);
        this.configPath = target;
        this.configMaterialized = true;
        return target;
    }

    /** Redacts anything that could carry a credential or local path out of an error. */
    redact(text: string): string {
        let out = text;
        if (this.config.accessToken) out = out.split(this.config.accessToken).join('***');
        if (this.config.rcloneConfigText) {
            for (const line of this.config.rcloneConfigText.split('\n')) {
                const value = line.split('=').slice(1).join('=').trim();
                if (value.length >= 8) out = out.split(value).join('***');
            }
        }
        if (this.configPath) out = out.split(this.configPath).join('<rclone-config>');
        out = out.split(rcloneConfigDir()).join('<rclone-config-dir>');
        return out;
    }

    private describeFailure(label: string, code: number, tail: string): string {
        const clean = this.redact(tail).replace(/\s+/g, ' ').trim().slice(-4096);
        return `rclone ${label}失败（退出码 ${code}）${clean ? `：${clean}` : ''}`;
    }

    private async runRclone(
        args: string[],
        options: {
            timeoutMs?: number;
            signal?: AbortSignal;
            onProgress?: (transferredBytes: number, totalBytes: number) => void;
            progressTotalBytes?: number;
        } = {},
    ): Promise<RcloneRunResult> {
        const configPath = await this.ensureConfigFile();
        options.signal?.throwIfAborted();
        const child: ChildProcess = spawn(
            'rclone', ['--config', configPath, ...RCLONE_PACING_ARGS, ...args],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdoutTail: Buffer = Buffer.alloc(0);
        let stderrTail: Buffer = Buffer.alloc(0);
        const appendTail = (buffer: Buffer, chunk: Buffer): Buffer => {
            const next = Buffer.concat([buffer, chunk]);
            return next.length > STDERR_TAIL_BYTES ? next.subarray(next.length - STDERR_TAIL_BYTES) : next;
        };
        child.stdout?.on('data', (chunk: Buffer) => { stdoutTail = appendTail(stdoutTail, chunk); });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrTail = appendTail(stderrTail, chunk);
            if (options.onProgress && options.progressTotalBytes !== undefined) {
                for (const line of chunk.toString('utf8').split('\n')) {
                    const parsed = parseRcloneJsonProgress(line);
                    if (parsed !== null) options.onProgress(Math.min(parsed, options.progressTotalBytes), options.progressTotalBytes);
                }
            }
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        if (options.timeoutMs) {
            timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
            timeout.unref?.();
        }
        const onAbort = () => { child.kill('SIGTERM'); };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const code = await new Promise<number>((resolve, reject) => {
                child.once('error', reject);
                child.once('close', resolve);
            }).catch((error: unknown) => {
                throw new RcloneError(`rclone 启动失败：${error instanceof Error ? error.message : String(error)}`);
            });
            return {
                code,
                stdout: stdoutTail.toString('utf8'),
                stderr: stderrTail.toString('utf8'),
            };
        } finally {
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', onAbort);
        }
    }

    private remotePath(storedPath: string): string {
        const relative = normalizeStoredPath(storedPath);
        const base = this.config.basePath === '/' ? '' : this.config.basePath.slice(1);
        const full = base ? `${base}/${relative}` : relative;
        return `${this.config.remoteName}:${full}`;
    }

    private remoteDirPath(storedPath: string): string | null {
        const relative = normalizeStoredPath(storedPath);
        const parent = relative.split('/').slice(0, -1).join('/');
        if (!parent) return null;
        const base = this.config.basePath === '/' ? '' : this.config.basePath.slice(1);
        const full = base ? `${base}/${parent}` : parent;
        return `${this.config.remoteName}:${full}`;
    }

    private async ensureRemoteDirectory(storedPath: string): Promise<void> {
        const dir = this.remoteDirPath(storedPath);
        if (!dir) return;
        // 每次上传都 mkdir 是纯浪费：同一目录 1 小时内只确认一次。
        const confirmedAt = this.confirmedDirectories.get(dir);
        if (confirmedAt !== undefined && Date.now() - confirmedAt < CONFIRMED_DIRECTORY_TTL_MS) return;
        const result = await this.runRclone(['mkdir', dir, '--low-level-retries', '1'], { timeoutMs: 90_000 });
        if (result.code !== 0) {
            throw new RcloneError(this.describeFailure('创建远端目录', result.code, result.stderr), result.code);
        }
        this.confirmedDirectories.set(dir, Date.now());
    }

    async probe(): Promise<void> {
        const base = this.config.basePath === '/' ? '' : this.config.basePath.slice(1);
        const target = `${this.config.remoteName}:${base}`;
        try {
            const result = await this.runRclone(
                ['lsd', target, '--max-depth', '1', '--low-level-retries', '1'],
                { timeoutMs: 90_000 },
            );
            if (result.code === 0) return;
            if (result.code === 3 || result.code === 4) {
                // The base directory may simply not exist yet (first upload creates
                // it). Fall back to the remote root: reachable root means the
                // credentials work; a missing base is not an auth failure.
                const root = await this.runRclone(
                    ['lsd', `${this.config.remoteName}:`, '--max-depth', '1', '--low-level-retries', '1'],
                    { timeoutMs: 90_000 },
                );
                if (root.code === 0) return;
                throw new RcloneError(this.describeFailure('连接测试（远端根目录）', root.code, root.stderr), root.code);
            }
            throw new RcloneError(this.describeFailure('连接测试', result.code, result.stderr), result.code);
        } catch (error) {
            if (error instanceof StorageProbeError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new StorageProbeError('rclone', message.startsWith('rclone ') ? message : `rclone 连接测试失败：${message}`);
        }
    }

    async fileExists(fileName: string, folder?: string | null): Promise<boolean> {
        const storedPath = joinStoredPath(folder, fileName);
        const result = await this.runRclone(
            ['lsjson', '--stat', this.remotePath(storedPath), '--low-level-retries', '1'],
            { timeoutMs: 90_000 },
        );
        if (result.code === 0) return true;
        if (result.code === 3 || result.code === 4) return false;
        throw new RcloneError(this.describeFailure('检查文件是否存在', result.code, result.stderr), result.code);
    }

    async saveFile(tempPath: string, fileName: string, _mimeType: string, folder?: string | null, options?: StorageWriteOptions): Promise<string> {
        options?.signal?.throwIfAborted();
        const storedPath = joinStoredPath(folder, fileName);
        if (await this.fileExists(fileName, folder)) {
            throw new RcloneError('rclone 上传目标已存在，拒绝覆盖');
        }
        const stats = await fs.promises.stat(tempPath);
        await this.ensureRemoteDirectory(storedPath);
        const result = await this.runRclone(
            ['copyto', tempPath, this.remotePath(storedPath),
                '--transfers', '1', '--checkers', '2',
                '--contimeout', '20s', '--timeout', '5m',
                '--stats', '1s', '--use-json-log'],
            { signal: options?.signal, onProgress: options?.onProgress, progressTotalBytes: stats.size },
        );
        if (result.code !== 0) {
            throw new RcloneError(this.describeFailure('上传', result.code, result.stderr), result.code);
        }
        const remoteSize = await this.getFileSize(storedPath);
        if (remoteSize !== stats.size) {
            throw new RcloneError(`rclone 上传后文件大小校验失败：远端 ${remoteSize} 字节，本地 ${stats.size} 字节`);
        }
        options?.onProgress?.(stats.size, stats.size);
        return storedPath;
    }

    async openUploadStream(
        fileName: string,
        _mimeType: string,
        folder: string | null | undefined,
        totalBytes: number,
        options: StorageUploadStreamOptions = {},
    ): Promise<StorageUploadStream> {
        if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
            throw new Error('流式上传需要已知且大于 0 的文件大小');
        }
        options.signal?.throwIfAborted();
        const storedPath = joinStoredPath(folder, fileName);
        const safeBase = fileName.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '_');
        const tempName = `.uploading-${crypto.randomUUID()}-${safeBase}`.slice(0, 200);
        assertSafeSegment(tempName, '临时文件名');
        const tempStoredPath = joinStoredPath(folder, tempName);
        await this.ensureRemoteDirectory(tempStoredPath);
        const configPath = await this.ensureConfigFile();
        const args = ['--config', configPath, 'rcat', this.remotePath(tempStoredPath),
            '--size', String(totalBytes),
            '--contimeout', '20s', '--timeout', '5m',
            // Whole-operation retry would restart the stream from scratch on a
            // consumed stdin, so keep --retries 1 here: per-chunk 429s are
            // absorbed by --low-level-retries within the same process instead.
            '--tpslimit', '2', '--tpslimit-burst', '1',
            '--retries', '1', '--low-level-retries', '10', '--stats', '0'];
        if (this.config.mode === 'drime') {
            const chunkMiB = rcloneDrimeChunkSizeMiB(totalBytes);
            args.push('--drime-chunk-size', `${chunkMiB}Mi`, '--drime-upload-concurrency', '2');
        }
        const child: ChildProcessWithoutNullStreams = spawn('rclone', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const stream = new RcloneUploadStream(this, child, storedPath, tempStoredPath, totalBytes, options.signal);
        return stream;
    }

    async getFileStream(storedPath: string, options?: StorageReadOptions): Promise<NodeJS.ReadableStream> {
        options?.signal?.throwIfAborted();
        const configPath = await this.ensureConfigFile();
        const args = ['--config', configPath, 'cat', this.remotePath(storedPath), '--contimeout', '20s', '--timeout', '5m',
            '--tpslimit', '2', '--tpslimit-burst', '1'];
        const range = parseRangeHeader(options?.range);
        if (range) {
            args.push('--offset', String(range.offset));
            if (range.count !== undefined) args.push('--count', String(range.count));
        }
        const child: ChildProcess = spawn('rclone', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderrTail: Buffer = Buffer.alloc(0);
        let settled = false;
        child.stderr?.on('data', (chunk: Buffer) => {
            const next = Buffer.concat([stderrTail, chunk]);
            stderrTail = next.length > STDERR_TAIL_BYTES ? next.subarray(next.length - STDERR_TAIL_BYTES) : next;
        });
        const stream: Readable = child.stdout as unknown as Readable;
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            stream.destroy(error);
        };
        child.once('error', (error) => fail(new RcloneError(this.describeFailure('下载', -1, String(error?.message || error)))));
        child.once('close', (code) => {
            if (code !== 0 && code !== null) {
                fail(new RcloneError(this.describeFailure('下载', code, stderrTail.toString('utf8')), code));
            }
        });
        const onAbort = () => { child.kill('SIGTERM'); };
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        stream.once('close', () => {
            options?.signal?.removeEventListener('abort', onAbort);
            if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
        });
        return stream;
    }

    async getPreviewUrl(_storedPath: string): Promise<string> {
        return '';
    }

    async deleteFile(storedPath: string): Promise<void> {
        const result = await this.runRclone(
            ['deletefile', this.remotePath(storedPath), '--low-level-retries', '1'],
            { timeoutMs: 90_000 },
        );
        if (result.code === 0 || result.code === 3 || result.code === 4) return;
        throw new RcloneError(this.describeFailure('删除文件', result.code, result.stderr), result.code);
    }

    async getFileSize(storedPath: string): Promise<number> {
        const remote = this.remotePath(storedPath);
        const result = await this.runRclone(
            ['size', remote, '--json', '--low-level-retries', '1'],
            { timeoutMs: 90_000 },
        );
        if (result.code === 0) {
            try {
                const parsed = JSON.parse(result.stdout) as { bytes?: unknown };
                const bytes = Number(parsed.bytes);
                if (Number.isSafeInteger(bytes) && bytes >= 0) return bytes;
            } catch { /* fall through to lsjson fallback */ }
        }
        // Drime-backed remotes can fail `size` on a single object; resolve via the parent listing.
        const relative = normalizeStoredPath(storedPath);
        const parent = relative.split('/').slice(0, -1).join('/');
        const name = relative.split('/').pop()!;
        const base = this.config.basePath === '/' ? '' : this.config.basePath.slice(1);
        const parentRemote = parent ? `${this.config.remoteName}:${base ? `${base}/${parent}` : parent}` : `${this.config.remoteName}:${base}`;
        const listed = await this.runRclone(
            ['lsjson', parentRemote, '--files-only', '--max-depth', '1', '--low-level-retries', '1'],
            { timeoutMs: 90_000 },
        );
        if (listed.code !== 0) {
            throw new RcloneError(this.describeFailure('获取文件大小', result.code, result.stderr || listed.stderr), result.code);
        }
        try {
            const entries = JSON.parse(listed.stdout) as Array<{ Name?: unknown; Size?: unknown; IsDir?: unknown }>;
            for (const entry of entries) {
                if (entry.Name === name && entry.IsDir !== true) {
                    const size = Number(entry.Size);
                    if (Number.isSafeInteger(size) && size >= 0) return size;
                }
            }
        } catch {
            throw new RcloneError('rclone 获取文件大小失败：无法解析远端文件清单');
        }
        throw new RcloneError('rclone 获取文件大小失败：远端找不到该文件');
    }

    /** Server-side rename of one remote object to another. Throws on failure. */
    async moveFile(fromStoredPath: string, toStoredPath: string): Promise<void> {
        const result = await this.runRclone(
            ['moveto', this.remotePath(fromStoredPath), this.remotePath(toStoredPath)],
            { timeoutMs: 120_000 },
        );
        if (result.code !== 0) {
            throw new RcloneError(this.describeFailure('远端改名', result.code, result.stderr), result.code);
        }
    }

    /** Best-effort removal of a remote temporary object; never throws. */
    async removeQuietly(storedPath: string): Promise<void> {
        try { await this.deleteFile(storedPath); } catch { /* already gone or unreachable; keep the failure local */ }
    }
}

function parseRcloneJsonProgress(line: string): number | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
        const parsed = JSON.parse(trimmed) as { stats?: { bytes?: unknown; transferring?: Array<{ bytes?: unknown }> } };
        const stats = parsed.stats;
        if (!stats || typeof stats.bytes !== 'number') return null;
        const active = stats.transferring?.[0];
        const bytes = typeof active?.bytes === 'number' ? active.bytes : stats.bytes;
        return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
    } catch {
        return null;
    }
}

function parseRangeHeader(range: string | undefined): { offset: number; count?: number } | null {
    if (!range) return null;
    const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
    if (!match) throw new Error('不支持的 Range 请求');
    const offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('不支持的 Range 请求');
    if (match[2] === '') return { offset };
    const end = Number(match[2]);
    if (!Number.isSafeInteger(end) || end < offset) throw new Error('不支持的 Range 请求');
    return { offset, count: end - offset + 1 };
}

/** Backpressure-aware stdin sink over `rclone rcat`, with size-verified rename on finish. */
class RcloneUploadStream implements StorageUploadStream {
    readonly storedPath: string;
    readonly tempPath: string;
    bytesWritten = 0;
    private finished = false;
    private aborted = false;
    private stderrTail: Buffer = Buffer.alloc(0);
    private stdoutTail: Buffer = Buffer.alloc(0);
    private exitPromise: Promise<number>;

    constructor(
        private readonly provider: RcloneStorageProvider,
        private readonly child: ChildProcessWithoutNullStreams,
        storedPath: string,
        tempPath: string,
        private readonly totalBytes: number,
        private readonly signal?: AbortSignal,
    ) {
        this.storedPath = storedPath;
        this.tempPath = tempPath;
        child.stdout.on('data', (chunk: Buffer) => { this.stdoutTail = this.appendTail(this.stdoutTail, chunk); });
        child.stderr.on('data', (chunk: Buffer) => { this.stderrTail = this.appendTail(this.stderrTail, chunk); });
        this.exitPromise = new Promise<number>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
        });
        signal?.addEventListener('abort', () => { void this.abort(); }, { once: true });
    }

    private appendTail(buffer: Buffer, chunk: Buffer): Buffer {
        const next = Buffer.concat([buffer, chunk]);
        return next.length > STDERR_TAIL_BYTES ? next.subarray(next.length - STDERR_TAIL_BYTES) : next;
    }

    private childFailedError(label: string): RcloneError {
        const tail = this.provider.redact(this.stderrTail.toString('utf8') || this.stdoutTail.toString('utf8'));
        const code = this.child.exitCode ?? undefined;
        return new RcloneError(
            `rclone 流式上传${label}（退出码 ${code ?? '未知'}）${tail ? `：${tail.replace(/\s+/g, ' ').trim().slice(-4096)}` : ''}`,
            code,
        );
    }

    async write(chunk: Buffer): Promise<void> {
        if (this.finished) throw new Error('rclone 流式写入已经结束');
        if (this.aborted) throw new Error('rclone 流式写入已取消');
        this.signal?.throwIfAborted();
        if (this.child.exitCode !== null) throw this.childFailedError('已失败');
        if (!chunk.length) return;
        const accepted = this.child.stdin.write(chunk);
        if (!accepted) {
            const drain = new Promise<void>((resolve, reject) => {
                const onError = (error: Error) => {
                    cleanup();
                    reject(error);
                };
                const onDrain = () => {
                    cleanup();
                    resolve();
                };
                const cleanup = () => {
                    this.child.stdin.off('error', onError);
                    this.child.stdin.off('drain', onDrain);
                };
                this.child.stdin.once('error', onError);
                this.child.stdin.once('drain', onDrain);
            });
            const exited = this.exitPromise.then((code) => {
                throw this.childFailedError(code === 0 ? '已结束' : '已失败');
            });
            await Promise.race([drain, exited]).catch((error: unknown) => {
                if (error instanceof RcloneError) throw error;
                if (this.child.exitCode !== null) throw this.childFailedError('已失败');
                throw new RcloneError('rclone 流式写入失败');
            });
        }
        this.bytesWritten += chunk.length;
    }

    async finish(): Promise<string> {
        if (this.finished) return this.storedPath;
        if (this.aborted) throw new Error('rclone 流式写入已取消');
        this.signal?.throwIfAborted();
        this.finished = true;
        try {
            this.child.stdin.end();
        } catch { /* stdin already closed */ }
        const code = await this.exitPromise;
        if (code !== 0) throw this.childFailedError('失败');
        if (this.bytesWritten !== this.totalBytes) {
            throw new Error(`流式传输大小不一致：已写 ${this.bytesWritten} 字节，预期 ${this.totalBytes} 字节`);
        }
        const tempSize = await this.provider.getFileSize(this.tempPath);
        if (tempSize !== this.totalBytes) {
            throw new Error(`流式上传后临时文件大小校验失败：远端 ${tempSize} 字节，预期 ${this.totalBytes} 字节`);
        }
        if (await this.provider.fileExists(this.storedPath.split('/').pop()!, this.storedPath.split('/').slice(0, -1).join('/') || null)) {
            throw new Error('正式文件已存在，拒绝覆盖；临时文件已保留，请人工核对');
        }
        await this.provider.moveFile(this.tempPath, this.storedPath);
        const finalSize = await this.provider.getFileSize(this.storedPath);
        if (finalSize !== this.totalBytes) {
            throw new Error(`流式改名后正式文件大小校验失败：远端 ${finalSize} 字节，预期 ${this.totalBytes} 字节`);
        }
        return this.storedPath;
    }

    async abort(): Promise<void> {
        if (this.finished || this.aborted) return;
        this.aborted = true;
        try { this.child.stdin.destroy(); } catch { /* already closed */ }
        if (this.child.exitCode === null) {
            this.child.kill('SIGTERM');
            const exited = await Promise.race([
                this.exitPromise.then(() => true),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
            ]);
            if (!exited && this.child.exitCode === null) {
                this.child.kill('SIGKILL');
                await this.exitPromise.catch(() => undefined);
            }
        }
        await this.exitPromise.catch(() => undefined);
        await this.provider.removeQuietly(this.tempPath);
    }
}
