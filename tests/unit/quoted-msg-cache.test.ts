import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    cacheInboundDownloadCode,
    getCachedDownloadCode,
    clearQuotedMsgCacheForTest,
} from '../../src/quoted-msg-cache';

describe('quoted-msg-cache', () => {
    beforeEach(() => {
        clearQuotedMsgCacheForTest();
    });

    it('基本缓存写入和读取', () => {
        cacheInboundDownloadCode(
            'default',
            'conv1',
            'msg1',
            'dl_code_1',
            'file',
            Date.now(),
        );

        const entry = getCachedDownloadCode('default', 'conv1', 'msg1');
        expect(entry).not.toBeNull();
        expect(entry!.downloadCode).toBe('dl_code_1');

        expect(getCachedDownloadCode('default', 'conv1', 'msg_not_exist')).toBeNull();
        expect(getCachedDownloadCode('default', 'conv_not_exist', 'msg1')).toBeNull();
    });

    it('TTL 过期后返回 null', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        cacheInboundDownloadCode('default', 'conv1', 'msg1', 'dl_code_1', 'file', 0);

        expect(getCachedDownloadCode('default', 'conv1', 'msg1')).not.toBeNull();

        vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

        expect(getCachedDownloadCode('default', 'conv1', 'msg1')).toBeNull();

        vi.useRealTimers();
    });

    it('每个会话上限淘汰', () => {
        const baseTime = Date.now();
        for (let i = 0; i <= 100; i++) {
            cacheInboundDownloadCode(
                'default',
                'conv_same',
                `msg_${i}`,
                `code_${i}`,
                'file',
                baseTime + i,
            );
        }

        expect(getCachedDownloadCode('default', 'conv_same', 'msg_100')).not.toBeNull();
        expect(getCachedDownloadCode('default', 'conv_same', 'msg_100')!.downloadCode).toBe(
            'code_100',
        );

        expect(getCachedDownloadCode('default', 'conv_same', 'msg_0')).toBeNull();
    });

    it('全局会话上限淘汰', () => {
        const baseTime = Date.now();
        for (let i = 0; i <= 1000; i++) {
            cacheInboundDownloadCode(
                'default',
                `conv_${i}`,
                'msg1',
                `code_${i}`,
                'file',
                baseTime + i,
            );
        }

        expect(getCachedDownloadCode('default', 'conv_1000', 'msg1')).not.toBeNull();
        expect(getCachedDownloadCode('default', 'conv_1000', 'msg1')!.downloadCode).toBe(
            'code_1000',
        );

        expect(getCachedDownloadCode('default', 'conv_0', 'msg1')).toBeNull();
    });
});
