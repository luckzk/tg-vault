export const UPSTREAM_UPDATE_REPOSITORY = 'hicocos/tg-vault';

/**
 * 是否默认从源码构建更新：版本检查的仓库不是上游时（如 fork 部署），
 * 拉取模式会拉到上游 latest 镜像、丢掉 fork 改动，所以默认走源码构建。
 * 仓库名未知时保守地默认拉取模式。
 */
export function shouldDefaultBuildFromSource(repository: string | null | undefined): boolean {
    if (typeof repository !== 'string') return false;
    const normalized = repository.trim().toLowerCase();
    if (!normalized) return false;
    return normalized !== UPSTREAM_UPDATE_REPOSITORY;
}
