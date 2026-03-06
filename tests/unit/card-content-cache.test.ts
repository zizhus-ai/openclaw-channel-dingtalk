import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    cacheCardContent,
    clearCardContentCacheForTest,
    findCardContent,
} from '../../src/card-service';

describe('card-content-cache', () => {
    beforeEach(() => {
        clearCardContentCacheForTest();
    });

    it('基本读写（±2秒时间匹配）', () => {
        cacheCardContent('default', 'conv1', '机器人回复内容', 1000000);

        expect(findCardContent('default', 'conv1', 1000100)).toBe('机器人回复内容');

        expect(findCardContent('default', 'conv1', 1005000)).toBeNull();

        expect(findCardContent('default', 'conv_other', 1000100)).toBeNull();
    });

    it('TTL 过期后返回 null', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000000);

        cacheCardContent('default', 'conv1', '内容', 1000000);
        expect(findCardContent('default', 'conv1', 1000000)).toBe('内容');

        vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

        expect(findCardContent('default', 'conv1', 1000000)).toBeNull();

        vi.useRealTimers();
    });

    it('每个会话上限（20 条）淘汰最早的', () => {
        const conversationId = 'conv_limit';
        for (let i = 1; i <= 21; i++) {
            cacheCardContent('default', conversationId, `content_${i}`, i * 4000);
        }

        expect(findCardContent('default', conversationId, 84000)).toBe('content_21');
        expect(findCardContent('default', conversationId, 4000)).toBeNull();
    });

    it('全局会话上限（500 个）淘汰最久未活跃的', () => {
        for (let i = 0; i <= 500; i++) {
            cacheCardContent('default', `conv_${i}`, `content_${i}`, 1000000 + i);
        }

        expect(findCardContent('default', 'conv_500', 1000500)).toBe('content_500');
        expect(findCardContent('default', 'conv_0', 1000000)).toBeNull();
    });

    it('单聊和群聊独立缓存', () => {
        cacheCardContent('default', 'dm_conv', '单聊内容', 1000000);
        cacheCardContent('default', 'group_conv', '群聊内容', 2000000);

        expect(findCardContent('default', 'dm_conv', 1000100)).toBe('单聊内容');
        expect(findCardContent('default', 'group_conv', 2000100)).toBe('群聊内容');
    });
});
