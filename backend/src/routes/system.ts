import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireAuth } from './auth.js';
import type { UpdateChecker } from '../services/updateChecker.js';
import {
    getPanelUpdateStatus,
    getUpdateAgentState,
    getUpdateDir,
    UpdateJobConflictError,
    UpdateRequestWriteError,
    writeUpdateRequest,
} from '../services/panelUpdate.js';

export function createSystemRouter(checker: UpdateChecker): Router {
    const router = Router();
    const manualCheckLimiter = rateLimit({
        windowMs: 60_000,
        max: 3,
        message: { error: '版本检查请求过于频繁，请稍后再试' },
        standardHeaders: true,
        legacyHeaders: false,
    });
    // 一键更新是重操作：同一管理员 10 分钟内最多提交 1 次。心跳离线时
    // 在限流器之前就返回 503，不消耗本次额度。
    const applyUpdateLimiter = rateLimit({
        windowMs: 10 * 60_000,
        max: 1,
        message: { error: '更新请求过于频繁，请 10 分钟后再试', code: 'UPDATE_APPLY_RATE_LIMITED' },
        standardHeaders: true,
        legacyHeaders: false,
    });
    const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

    const requireUpdateAgent = (_req: Request, res: Response, next: NextFunction) => {
        const agent = getUpdateAgentState(getUpdateDir());
        if (!agent.online) {
            res.status(503).json({
                error: '更新代理未运行，无法从面板更新',
                code: 'UPDATE_AGENT_OFFLINE',
                manualCommand: 'cd tg-vault && ./deploy/install.sh',
            });
            return;
        }
        next();
    };

    router.get('/update-status', requireAuth, async (_req: Request, res: Response) => {
        noStore(res);
        try {
            res.json(getPanelUpdateStatus(await checker.getStatus()));
        } catch (error) {
            console.error('读取版本状态失败:', error);
            res.status(500).json({ error: '读取版本状态失败' });
        }
    });

    router.post('/update-check', requireAuth, manualCheckLimiter, async (_req: Request, res: Response) => {
        noStore(res);
        try {
            res.json(await checker.checkNow());
        } catch (error) {
            console.error('手动检查版本失败:', error);
            res.status(500).json({ error: '检查版本失败' });
        }
    });

    router.post('/update-apply', requireAuth, requireUpdateAgent, applyUpdateLimiter, async (req: Request, res: Response) => {
        noStore(res);
        const body = req.body as unknown;
        const buildFromSource = body && typeof body === 'object' && 'buildFromSource' in body
            ? (body as Record<string, unknown>).buildFromSource
            : false;
        if (typeof buildFromSource !== 'boolean') {
            res.status(400).json({ error: 'buildFromSource 须为布尔值', code: 'UPDATE_APPLY_INVALID_BODY' });
            return;
        }
        try {
            const request = writeUpdateRequest(buildFromSource);
            res.status(202).json({ jobId: request.id, state: 'queued' });
        } catch (error) {
            if (error instanceof UpdateJobConflictError) {
                res.status(409).json({ error: error.message, code: 'UPDATE_JOB_ACTIVE' });
                return;
            }
            if (error instanceof UpdateRequestWriteError) {
                res.status(503).json({ error: '无法写入更新请求，请检查更新目录权限', code: 'UPDATE_REQUEST_WRITE_FAILED' });
                return;
            }
            console.error('提交更新请求失败:', error);
            res.status(500).json({ error: '提交更新请求失败' });
        }
    });

    return router;
}

export default createSystemRouter;
