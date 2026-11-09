import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { UpdateStatus } from './updateChecker.js';

/**
 * 面板一键更新：后端与 host 侧 updater 边车之间的文件协议。
 *
 * 后端容器没有 docker socket、没有宿主机 git/compose 访问权，所以更新
 * 本身不在后端执行。后端只在共享的 /data 卷下写请求文件，updater
 * （docker-compose.yml 里 profile 为 updater 的服务）轮询并执行：
 *
 *   后端写  /data/update/request.json   { id, requestedAt, buildFromSource }
 *   updater 写 /data/update/heartbeat.json { at, version }（每 10 秒）
 *   updater 写 /data/update/status.json    { id, state, step, startedAt,
 *                                            finishedAt, fromSha, toSha,
 *                                            error, logTail }
 *
 * 更新目录取 UPDATE_DIR，默认 /data/update。宿主机路径、docker socket
 * 路径等信息不经 API 泄露给前端，只返回状态与步骤。
 */

export const UPDATE_HEARTBEAT_STALE_MS = 90_000;

export type UpdateJobState = 'queued' | 'running' | 'done' | 'failed';

export interface UpdateAgentState {
    online: boolean;
    lastHeartbeat: string | null;
}

export interface UpdateJobStatus {
    id: string;
    state: UpdateJobState;
    step: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    fromSha: string | null;
    toSha: string | null;
    error: string | null;
    logTail: string[];
}

export interface PanelUpdateStatus extends UpdateStatus {
    agent: UpdateAgentState;
    job: UpdateJobStatus | null;
}

export interface UpdateRequest {
    id: string;
    requestedAt: string;
    buildFromSource: boolean;
}

export interface UpdateHeartbeat {
    at: string;
    version: string;
}

const JOB_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'done', 'failed']);

export function getUpdateDir(updateDir = process.env.UPDATE_DIR): string {
    return updateDir && updateDir.trim() ? updateDir.trim() : '/data/update';
}

function readJsonFile<T>(filePath: string): T | null {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asIsoString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : value;
}

function normalizeJobStatus(value: unknown): UpdateJobStatus | null {
    if (!isRecord(value)) return null;
    if (typeof value.id !== 'string' || !value.id) return null;
    if (typeof value.state !== 'string' || !JOB_STATES.has(value.state)) return null;
    const logTail = Array.isArray(value.logTail)
        ? value.logTail.filter((line): line is string => typeof line === 'string').slice(-100)
        : [];
    return {
        id: value.id,
        state: value.state as UpdateJobState,
        step: typeof value.step === 'string' ? value.step : null,
        startedAt: asIsoString(value.startedAt),
        finishedAt: asIsoString(value.finishedAt),
        fromSha: typeof value.fromSha === 'string' ? value.fromSha.slice(0, 40) : null,
        toSha: typeof value.toSha === 'string' ? value.toSha.slice(0, 40) : null,
        error: typeof value.error === 'string' ? value.error.slice(0, 500) : null,
        logTail,
    };
}

export function isUpdateJobActive(job: UpdateJobStatus | null): boolean {
    return job !== null && (job.state === 'queued' || job.state === 'running');
}

export function readUpdateHeartbeat(updateDir = getUpdateDir()): UpdateHeartbeat | null {
    const parsed = readJsonFile<unknown>(path.join(updateDir, 'heartbeat.json'));
    if (!isRecord(parsed)) return null;
    const at = asIsoString(parsed.at);
    if (!at || typeof parsed.version !== 'string') return null;
    return { at, version: parsed.version };
}

export function getUpdateAgentState(updateDir = getUpdateDir(), now = Date.now()): UpdateAgentState {
    const heartbeat = readUpdateHeartbeat(updateDir);
    if (!heartbeat) return { online: false, lastHeartbeat: null };
    const ageMs = now - new Date(heartbeat.at).getTime();
    return { online: ageMs >= 0 && ageMs <= UPDATE_HEARTBEAT_STALE_MS, lastHeartbeat: heartbeat.at };
}

export function readUpdateJob(updateDir = getUpdateDir()): UpdateJobStatus | null {
    return normalizeJobStatus(readJsonFile<unknown>(path.join(updateDir, 'status.json')));
}

export function hasPendingUpdateRequest(updateDir = getUpdateDir()): boolean {
    return fs.existsSync(path.join(updateDir, 'request.json'));
}

export function getPanelUpdateStatus(
    checkerStatus: UpdateStatus,
    updateDir = getUpdateDir(),
    now = Date.now(),
): PanelUpdateStatus {
    return {
        ...checkerStatus,
        agent: getUpdateAgentState(updateDir, now),
        job: readUpdateJob(updateDir),
    };
}

export class UpdateJobConflictError extends Error {
    constructor(message = '已有更新任务在进行中') {
        super(message);
        this.name = 'UpdateJobConflictError';
    }
}

export class UpdateRequestWriteError extends Error {
    constructor(message = '无法写入更新请求') {
        super(message);
        this.name = 'UpdateRequestWriteError';
    }
}

/** 原子写更新请求文件（临时文件 + rename）。已有进行中任务或未认领请求时抛错。 */
export function writeUpdateRequest(
    buildFromSource: boolean,
    updateDir = getUpdateDir(),
): UpdateRequest {
    const job = readUpdateJob(updateDir);
    if (isUpdateJobActive(job) || hasPendingUpdateRequest(updateDir)) {
        throw new UpdateJobConflictError();
    }
    const request: UpdateRequest = {
        id: randomUUID(),
        requestedAt: new Date().toISOString(),
        buildFromSource,
    };
    try {
        fs.mkdirSync(updateDir, { recursive: true });
        const tmpPath = path.join(updateDir, `.request-${request.id}.tmp`);
        fs.writeFileSync(tmpPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
        fs.renameSync(tmpPath, path.join(updateDir, 'request.json'));
    } catch {
        throw new UpdateRequestWriteError();
    }
    return request;
}
