import { Cloud, Database, HardDrive, Network, Package, Server } from '../components/ui/icons';
import type { Icon } from '@phosphor-icons/react';

export interface ProviderMetadata {
    id: string;
    label: string;
    icon: Icon;
}

const providers: Record<string, ProviderMetadata> = {
    local: { id: 'local', label: 'Local', icon: HardDrive },
    onedrive: { id: 'onedrive', label: 'OneDrive', icon: Cloud },
    google_drive: { id: 'google_drive', label: 'Google Drive', icon: Database },
    aliyun_oss: { id: 'aliyun_oss', label: 'Aliyun OSS', icon: Database },
    s3: { id: 's3', label: 'S3', icon: Package },
    webdav: { id: 'webdav', label: 'WebDAV', icon: Network },
    openlist: { id: 'openlist', label: 'OpenList', icon: Server },
    rclone: { id: 'rclone', label: 'Rclone', icon: Cloud },
};

export function getProviderMetadata(provider?: string | null): ProviderMetadata {
    const id = provider || 'local';
    return providers[id] || { id, label: id, icon: Server };
}

export const STORAGE_PROVIDER_METADATA = providers;
