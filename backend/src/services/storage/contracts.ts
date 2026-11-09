export type StorageUploadProgress = (transferredBytes: number, totalBytes: number) => void;

export interface StorageReadOptions { range?: string; signal?: AbortSignal }

export interface StorageWriteOptions {
    signal?: AbortSignal;
    onProgress?: StorageUploadProgress;
}

export interface PreparedStorageWrite {
    storedPath: string;
    save(signal?: AbortSignal, onProgress?: StorageUploadProgress): Promise<string>;
}

/** A remote object written incrementally without touching local disk. */
export interface StorageUploadStream {
    /** Final remote path once finish() succeeds. */
    storedPath: string;
    /** Remote temporary path used while the stream is open. */
    tempPath: string;
    bytesWritten: number;
    write(chunk: Buffer): Promise<void>;
    finish(): Promise<string>;
    abort(): Promise<void>;
}

export interface StorageUploadStreamOptions {
    signal?: AbortSignal;
}

export interface IStorageProvider {
    id?: string; // 对于云盘，这是账户 ID
    name: string;
    /** Performs a read-only connectivity and authorization check. */
    probe(): Promise<void>;
    /** Checks the exact destination without reading file bytes or creating folders; only missing destinations return false. */
    fileExists(fileName: string, folder?: string | null): Promise<boolean>;
    /**
     * 保存文件
     * @param tempPath 临时文件路径
     * @param fileName 目标文件名
     * @param mimeType 文件类型
     * @returns 存储后的路径或标识符
     */
    saveFile(tempPath: string, fileName: string, mimeType: string, folder?: string | null, options?: StorageWriteOptions): Promise<string>;
    /** Allocates a stable object identity before any upload side effect. */
    prepareSaveFile?(tempPath: string, fileName: string, mimeType: string, folder?: string | null): Promise<PreparedStorageWrite>;

    /**
     * Opens a streaming upload that never lands on local disk. The caller feeds
     * exactly totalBytes in order, then finish() renames the remote temporary
     * object to its final path. Only providers that implement this can be used
     * for zero-local-disk transfers.
     */
    openUploadStream?(fileName: string, mimeType: string, folder: string | null | undefined, totalBytes: number, options?: StorageUploadStreamOptions): Promise<StorageUploadStream>;

    /**
     * 获取文件流（用于下载）
     * @param storedPath 存储路径或标识符
     */
    getFileStream(storedPath: string, options?: StorageReadOptions): Promise<NodeJS.ReadableStream>;

    /** Checks whether a remote media source still exists without downloading its bytes. */
    getFileAvailability?(storedPath: string): Promise<{ available: true }>;

    /** Probes whether the source bytes can be read without downloading the whole object. */
    probeFileReadable?(storedPath: string): Promise<{ available: true }>;

    /**
     * 获取预览URL（可能是临时的）
     * @param storedPath 存储路径或标识符
     */
    getPreviewUrl(storedPath: string): Promise<string>;

    /**
     * 删除文件
     * @param storedPath 存储路径或标识符
     */
    deleteFile(storedPath: string): Promise<void>;

    /**
     * 获取文件大小（可选）
     */
    getFileSize?(storedPath: string): Promise<number>;

    /** Returns remote account quota when the provider exposes it. */
    getQuota?(): Promise<{ totalBytes: number; usedBytes: number } | null>;


    /**
     * 创建分享链接
     * @param storedPath 存储路径或标识符
     * @param password 访问密码（可选）
     * @param expiration 过期时间 ISO 字符串（可选）
     */
    createShareLink?(storedPath: string, password?: string, expiration?: string): Promise<{ link: string; error?: string }>;
}

export interface StorageTargetSnapshot {
    provider: IStorageProvider;
    accountId: string | null;
    providerKey: string;
}

export class StorageProbeError extends Error {
    constructor(public readonly provider: string, message: string, public readonly causeCode?: string) {
        super(message);
        this.name = 'StorageProbeError';
    }
}
