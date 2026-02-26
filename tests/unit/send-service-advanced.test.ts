import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cardMocks = vi.hoisted(() => ({
    getActiveCardIdByTargetMock: vi.fn(),
    getCardByIdMock: vi.fn(),
    isCardInTerminalStateMock: vi.fn(),
    streamAICardMock: vi.fn(),
    deleteActiveCardByTargetMock: vi.fn(),
}));

const quoteJournalMocks = vi.hoisted(() => ({
    appendOutboundToQuoteJournalMock: vi.fn(),
    appendProactiveOutboundJournalMock: vi.fn(),
}));

vi.mock('../../src/auth', () => ({
    getAccessToken: vi.fn().mockResolvedValue('token_abc'),
}));

vi.mock('axios', () => {
    const mockAxios = vi.fn();
    return {
        default: mockAxios,
        isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    };
});

vi.mock('../../src/card-service', () => ({
    getActiveCardIdByTarget: cardMocks.getActiveCardIdByTargetMock,
    getCardById: cardMocks.getCardByIdMock,
    isCardInTerminalState: cardMocks.isCardInTerminalStateMock,
    streamAICard: cardMocks.streamAICardMock,
    deleteActiveCardByTarget: cardMocks.deleteActiveCardByTargetMock,
}));

vi.mock('../../src/quote-journal', () => ({
    appendOutboundToQuoteJournal: quoteJournalMocks.appendOutboundToQuoteJournalMock,
    appendProactiveOutboundJournal: quoteJournalMocks.appendProactiveOutboundJournalMock,
}));

import { sendMessage } from '../../src/send-service';
import {
    clearProactiveRiskObservationsForTest,
    getProactiveRiskObservation,
    recordProactiveRiskObservation,
} from '../../src/proactive-risk-registry';
import { AICardStatus } from '../../src/types';

const mockedAxios = vi.mocked(axios);

describe('send-service advanced branches', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        clearProactiveRiskObservationsForTest();
        cardMocks.getActiveCardIdByTargetMock.mockReset();
        cardMocks.getCardByIdMock.mockReset();
        cardMocks.isCardInTerminalStateMock.mockReset();
        cardMocks.streamAICardMock.mockReset();
        cardMocks.deleteActiveCardByTargetMock.mockReset();
        quoteJournalMocks.appendOutboundToQuoteJournalMock.mockReset();
        quoteJournalMocks.appendProactiveOutboundJournalMock.mockReset();
    });

    it('deletes active card mapping when card is terminal', async () => {
        cardMocks.getActiveCardIdByTargetMock.mockReturnValue('card_terminal');
        cardMocks.getCardByIdMock.mockReturnValue({ state: AICardStatus.FINISHED });
        cardMocks.isCardInTerminalStateMock.mockReturnValue(true);
        mockedAxios.mockResolvedValue({ data: { processQueryKey: 'q1' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id', messageType: 'card' } as any,
            'cidA1B2C3',
            'text',
            { accountId: 'main' }
        );

        expect(cardMocks.deleteActiveCardByTargetMock).toHaveBeenCalledWith('main:cidA1B2C3');
        expect(result.ok).toBe(true);
    });

    it('returns {ok:false} when proactive send throws', async () => {
        mockedAxios.mockRejectedValueOnce({
            message: 'network failed',
            response: { data: { code: 'invalidParameter', message: 'robotCode missing' } },
        });
        const log = { error: vi.fn() };

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'cidA1B2C3',
            'text',
            { log: log as any }
        );

        expect(result).toEqual({ ok: false, error: 'network failed' });
        const logs = log.error.mock.calls.map((args: unknown[]) => String(args[0]));
        expect(
            logs.some(
                (entry) =>
                    entry.includes('[DingTalk][ErrorPayload][send.message]') &&
                    entry.includes('code=invalidParameter') &&
                    entry.includes('message=robotCode missing')
            )
        ).toBe(true);
    });

    it('extracts messageId from legacy msgid field for session webhook send', async () => {
        mockedAxios.mockResolvedValueOnce({ data: { errcode: 0, errmsg: 'ok', msgid: 'legacy_msg_1' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'cidA1B2C3',
            'text',
            { sessionWebhook: 'https://session.webhook' } as any,
        );

        expect(result.ok).toBe(true);
        expect(result.messageId).toBe('legacy_msg_1');
    });

    it('delegates session outbound journaling when storePath is provided', async () => {
        mockedAxios.mockResolvedValueOnce({ data: { errcode: 0, errmsg: 'ok', msgid: 'legacy_msg_2' } } as any);

        await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'cidA1B2C3',
            'hello session',
            {
                sessionWebhook: 'https://session.webhook',
                accountId: 'main',
                storePath: '/tmp/sessions.json',
            } as any,
        );

        expect(quoteJournalMocks.appendOutboundToQuoteJournalMock).toHaveBeenCalledWith(
            expect.objectContaining({
                storePath: '/tmp/sessions.json',
                accountId: 'main',
                conversationId: 'cidA1B2C3',
                messageId: 'legacy_msg_2',
                messageType: 'outbound',
                text: 'hello session',
            }),
        );
    });

    it('delegates proactive outbound journaling when storePath is provided', async () => {
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'proactive_q_1' } } as any);

        await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'cidA1B2C3',
            'hello proactive',
            {
                accountId: 'main',
                storePath: '/tmp/sessions.json',
            } as any,
        );

        expect(quoteJournalMocks.appendProactiveOutboundJournalMock).toHaveBeenCalledWith(
            expect.objectContaining({
                storePath: '/tmp/sessions.json',
                accountId: 'main',
                conversationId: 'cidA1B2C3',
                messageId: 'proactive_q_1',
                messageType: 'outbound-proactive',
                text: 'hello proactive',
            }),
        );
    });

    it('includes proactive risk context in logs when proactive send fails', async () => {
        recordProactiveRiskObservation({
            accountId: 'main',
            targetId: '0341234567',
            level: 'high',
            reason: 'numeric-user-id',
            source: 'webhook-hint',
        });

        mockedAxios.mockRejectedValueOnce({
            message: 'forbidden',
            response: { status: 403, data: { code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied' } },
        });
        const log = { error: vi.fn(), debug: vi.fn() };

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            '0341234567',
            'text',
            { log: log as any, accountId: 'main' } as any,
        );

        expect(result).toEqual({ ok: false, error: 'forbidden' });
        const logs = log.error.mock.calls.map((args: unknown[]) => String(args[0]));
        expect(logs.some((entry) => entry.includes('proactiveRisk=high:numeric-user-id'))).toBe(true);
    });

    it('records proactive API risk observation when permission denied is returned', async () => {
        mockedAxios.mockRejectedValueOnce({
            message: 'forbidden',
            response: {
                status: 403,
                data: { code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied' },
            },
        });

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'manager123',
            'text',
            { accountId: 'main' } as any,
        );

        expect(result).toEqual({ ok: false, error: 'forbidden' });
        expect(getProactiveRiskObservation('main', 'manager123')).toMatchObject({
            source: 'proactive-api',
            level: 'high',
            reason: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
        });
    });
});
