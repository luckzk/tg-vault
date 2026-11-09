import type { UpdateStatus } from '../apiTypes';
import { apiRequest } from '../httpClient';
import { tr } from '../../i18n/runtime';
import { getApiHeaders } from './clientHeaders';

export class SystemClient {
    async getUpdateStatus(): Promise<UpdateStatus> {
        const response = await apiRequest('/api/system/update-status', {
            credentials: 'include',
            cache: 'no-store',
            headers: getApiHeaders(),
        });
        if (!response.ok) throw new Error(tr('errors.services.system.getVersionFailed'));
        return response.json();
    }

    async checkForUpdates(): Promise<UpdateStatus> {
        const response = await apiRequest('/api/system/update-check', {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            headers: getApiHeaders(),
        });
        if (response.status === 429) throw new Error(tr('errors.services.system.updateCheckRateLimited'));
        if (!response.ok) throw new Error(tr('errors.services.system.checkVersionFailed'));
        return response.json();
    }

    async applyUpdate(buildFromSource = false): Promise<{ jobId: string; state: string }> {
        const response = await apiRequest('/api/system/update-apply', {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            headers: getApiHeaders(),
            body: JSON.stringify({ buildFromSource }),
        });
        if (response.ok) return response.json();
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        if (response.status === 503 && payload?.error) throw new Error(payload.error);
        if (response.status === 409) throw new Error(tr('errors.services.system.updateApplyConflict'));
        if (response.status === 429) throw new Error(tr('errors.services.system.updateApplyRateLimited'));
        throw new Error(payload?.error || tr('errors.services.system.applyUpdateFailed'));
    }

    async healthCheck(): Promise<{ status: string; timestamp: string }> {
        const response = await apiRequest('/health');
        if (!response.ok) throw new Error(tr('errors.services.system.healthCheckFailed'));
        return response.json();
    }
}

export const systemClient = new SystemClient();
