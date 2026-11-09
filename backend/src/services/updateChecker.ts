import type { QueryResult } from 'pg';
import { query } from '../db/index.js';

export const DEFAULT_UPDATE_REPOSITORY = 'hicocos/tg-vault';
export const UPDATE_STATE_KEY = 'update_checker_state_v1';
const MAX_RELEASE_NOTES_LENGTH = 600;
const REQUEST_TIMEOUT_MS = 5_000;

export interface ReleaseInfo {
    version: string;
    tag: string;
    name: string;
    url: string;
    publishedAt: string | null;
    notes: string | null;
}

export interface PersistedUpdateState {
    etag: string | null;
    checkedAt: string | null;
    release: ReleaseInfo | null;
}

export interface UpdateStatus {
    enabled: boolean;
    repository: string;
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    releaseName: string | null;
    releaseUrl: string | null;
    publishedAt: string | null;
    checkedAt: string | null;
    stale: boolean;
    error: string | null;
}

export interface UpdateCheckStore {
    loadState(): Promise<PersistedUpdateState | null>;
    saveState(state: PersistedUpdateState): Promise<void>;
    listEligibleRecipients(): Promise<number[]>;
    claimDelivery(version: string, recipientId: string): Promise<boolean>;
    markDeliverySucceeded(version: string, recipientId: string): Promise<void>;
    markDeliveryFailed(version: string, recipientId: string, error: string): Promise<void>;
}

export interface UpdateChecker {
    getStatus(): Promise<UpdateStatus>;
    checkNow(): Promise<UpdateStatus>;
    deliverPendingBotNotifications(): Promise<number>;
}

export interface UpdateCheckerOptions {
    currentVersion: string;
    repository?: string;
    enabled?: boolean;
    store?: UpdateCheckStore;
    fetch?: typeof globalThis.fetch;
    sendBotMessage?: (recipientId: number, message: string) => Promise<void>;
    now?: () => Date;
}

type RunQuery = (sql: string, params?: unknown[]) => Promise<QueryResult<any>>;

export function normalizeVersion(input: string | null | undefined): string | null {
    const match = String(input || '').trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function compareVersions(left: string, right: string): -1 | 0 | 1 {
    const a = normalizeVersion(left);
    const b = normalizeVersion(right);
    if (!a || !b) throw new Error('invalid stable semantic version');
    const leftParts = a.split('.').map(Number);
    const rightParts = b.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        if (leftParts[index] > rightParts[index]) return 1;
        if (leftParts[index] < rightParts[index]) return -1;
    }
    return 0;
}

export function createPostgresUpdateCheckStore(runQuery: RunQuery = query): UpdateCheckStore {
    return {
        async loadState() {
            const result = await runQuery('SELECT value FROM system_settings WHERE key = $1', [UPDATE_STATE_KEY]);
            if (!result.rows[0]?.value) return null;
            try {
                const parsed = JSON.parse(String(result.rows[0].value));
                return {
                    etag: typeof parsed.etag === 'string' ? parsed.etag : null,
                    checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null,
                    release: parsed.release && typeof parsed.release === 'object' ? parsed.release as ReleaseInfo : null,
                };
            } catch {
                return null;
            }
        },
        async saveState(state) {
            await runQuery(
                `INSERT INTO system_settings (key, value) VALUES ($1, $2)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [UPDATE_STATE_KEY, JSON.stringify(state)],
            );
        },
        async listEligibleRecipients() {
            const { getConfiguredTelegramAllowedUsers } = await import('../utils/authSettings.js');
            const allowed = await getConfiguredTelegramAllowedUsers();
            if (allowed.length === 0) return [];
            const result = await runQuery(
                `SELECT user_id FROM telegram_auth
                 WHERE user_id = ANY($1::bigint[])
                 ORDER BY user_id`,
                [allowed],
            );
            return result.rows.map(row => Number(row.user_id)).filter(id => Number.isSafeInteger(id) && id > 0);
        },
        async claimDelivery(version, recipientId) {
            const result = await runQuery(
                `INSERT INTO update_notification_deliveries (version, channel, recipient_id, status, attempt_count, last_attempt_at, last_error)
                 VALUES ($1, 'telegram', $2, 'sending', 1, NOW(), NULL)
                 ON CONFLICT (version, channel, recipient_id) DO UPDATE SET
                    status = 'sending', attempt_count = update_notification_deliveries.attempt_count + 1,
                    last_attempt_at = NOW(), last_error = NULL
                 WHERE update_notification_deliveries.status = 'failed'
                    OR (update_notification_deliveries.status = 'sending' AND update_notification_deliveries.last_attempt_at < NOW() - INTERVAL '10 minutes')
                 RETURNING recipient_id`,
                [version, String(recipientId)],
            );
            return Boolean(result.rowCount);
        },
        async markDeliverySucceeded(version, recipientId) {
            await runQuery(
                `UPDATE update_notification_deliveries
                 SET status = 'delivered', delivered_at = NOW(), last_error = NULL
                 WHERE version = $1 AND channel = 'telegram' AND recipient_id = $2`,
                [version, String(recipientId)],
            );
        },
        async markDeliveryFailed(version, recipientId, error) {
            await runQuery(
                `UPDATE update_notification_deliveries
                 SET status = 'failed', last_error = $3
                 WHERE version = $1 AND channel = 'telegram' AND recipient_id = $2`,
                [version, String(recipientId), error.slice(0, 500)],
            );
        },
    };
}

function buildStatus(currentVersion: string, enabled: boolean, repository: string, state: PersistedUpdateState | null, stale: boolean, error: string | null): UpdateStatus {
    const release = state?.release || null;
    return {
        enabled,
        repository,
        currentVersion,
        latestVersion: release?.version || null,
        updateAvailable: Boolean(release && compareVersions(release.version, currentVersion) > 0),
        releaseName: release?.name || null,
        releaseUrl: release?.url || null,
        publishedAt: release?.publishedAt || null,
        checkedAt: state?.checkedAt || null,
        stale,
        error,
    };
}

function parseRelease(payload: any): ReleaseInfo | null {
    if (!payload || payload.draft === true || payload.prerelease === true) return null;
    const version = normalizeVersion(payload.tag_name);
    const url = typeof payload.html_url === 'string' && /^https:\/\/github\.com\//.test(payload.html_url) ? payload.html_url : null;
    if (!version || !url) return null;
    return {
        version,
        tag: String(payload.tag_name),
        name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 160) : `TG Vault v${version}`,
        url,
        publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
        notes: typeof payload.body === 'string' && payload.body.trim() ? payload.body.trim().slice(0, MAX_RELEASE_NOTES_LENGTH) : null,
    };
}

function botMessage(currentVersion: string, release: ReleaseInfo): string {
    const published = release.publishedAt ? `\n发布时间：${release.publishedAt.slice(0, 10)}` : '';
    const notes = release.notes ? `\n\n${release.notes}` : '';
    return `🆕 **TG Vault 新版本已发布**\n\n当前版本：v${currentVersion}\n最新版本：v${release.version}${published}${notes}\n\n查看发布说明：\n${release.url}`;
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
    const currentVersion = normalizeVersion(options.currentVersion);
    if (!currentVersion) throw new Error(`invalid current version: ${options.currentVersion}`);
    const repository = options.repository || DEFAULT_UPDATE_REPOSITORY;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid GitHub repository');
    const enabled = options.enabled ?? true;
    const store = options.store || createPostgresUpdateCheckStore();
    const request = options.fetch || globalThis.fetch;
    const now = options.now || (() => new Date());
    let transientError: string | null = null;
    let inFlight: Promise<UpdateStatus> | null = null;

    const getStatus = async () => buildStatus(currentVersion, enabled, repository, await store.loadState(), Boolean(transientError), transientError);

    const deliverPendingBotNotifications = async (): Promise<number> => {
        if (!enabled || !options.sendBotMessage) return 0;
        const state = await store.loadState();
        if (!state?.release || compareVersions(state.release.version, currentVersion) <= 0) return 0;
        let delivered = 0;
        for (const recipient of await store.listEligibleRecipients()) {
            if (!(await store.claimDelivery(state.release.version, String(recipient)))) continue;
            try {
                await options.sendBotMessage(recipient, botMessage(currentVersion, state.release));
                await store.markDeliverySucceeded(state.release.version, String(recipient));
                delivered += 1;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await store.markDeliveryFailed(state.release.version, String(recipient), message);
            }
        }
        return delivered;
    };

    const runCheck = async (): Promise<UpdateStatus> => {
        if (!enabled) return getStatus();
        const previous = await store.loadState();
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            timeout.unref?.();
            let response: Response;
            try {
                response = await request(`https://api.github.com/repos/${repository}/releases/latest`, {
                    signal: controller.signal,
                    headers: {
                        Accept: 'application/vnd.github+json',
                        'User-Agent': `tg-vault/${currentVersion}`,
                        ...(previous?.etag ? { 'If-None-Match': previous.etag } : {}),
                    },
                });
            } finally {
                clearTimeout(timeout);
            }
            const checkedAt = now().toISOString();
            let stateAfterCheck: PersistedUpdateState;
            if (response.status === 304 && previous?.release) {
                stateAfterCheck = { ...previous, checkedAt };
            } else {
                if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
                const release = parseRelease(await response.json());
                if (!release) throw new Error('latest release is not a valid stable release');
                stateAfterCheck = { etag: response.headers.get('etag'), checkedAt, release };
            }
            await store.saveState(stateAfterCheck);
            transientError = null;
            const status = buildStatus(currentVersion, enabled, repository, stateAfterCheck, false, null);
            await deliverPendingBotNotifications().catch(error => {
                console.warn('版本通知投递失败:', error instanceof Error ? error.message : String(error));
            });
            return status;
        } catch (error) {
            console.warn('版本检查失败:', error instanceof Error ? error.message : String(error));
            transientError = '暂时无法检查新版本，继续显示上次成功结果';
            return getStatus();
        }
    };

    return {
        getStatus,
        checkNow() {
            if (!inFlight) inFlight = runCheck().finally(() => { inFlight = null; });
            return inFlight;
        },
        deliverPendingBotNotifications,
    };
}
