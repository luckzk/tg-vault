export interface ProviderMetadata {
    id: string;
    label: string;
    emoji: string;
}

const PROVIDERS: Record<string, ProviderMetadata> = {
    local: { id: 'local', label: '本地存储', emoji: '💾' },
    onedrive: { id: 'onedrive', label: 'OneDrive', emoji: '☁️' },
    google_drive: { id: 'google_drive', label: 'Google Drive', emoji: '☁️' },
    aliyun_oss: { id: 'aliyun_oss', label: '阿里云 OSS', emoji: '☁️' },
    s3: { id: 's3', label: 'S3 存储', emoji: '📦' },
    webdav: { id: 'webdav', label: 'WebDAV', emoji: '🌐' },
    openlist: { id: 'openlist', label: 'OpenList', emoji: '🗂️' },
    rclone: { id: 'rclone', label: 'Rclone', emoji: '☁️' },
};

export function getProviderMetadata(providerId: string): ProviderMetadata {
    return PROVIDERS[providerId] || { id: providerId, label: providerId, emoji: '📦' };
}

export function getProviderDisplayName(providerId: string): string {
    const provider = getProviderMetadata(providerId);
    return `${provider.emoji} ${provider.label}`;
}
